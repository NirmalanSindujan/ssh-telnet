const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Telnet } = require("telnet-client");
const { Client: SSHClient } = require("ssh2");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(
  cors({
    origin: "http://localhost:3000", // your React app URL
    credentials: true,
  })
);
app.use(bodyParser.json());

const sessions = {}; // store telnet + ssh connections

/**
 * SSH CONNECT (raw shell, no username/password here)
 */
app.post("/ssh/connect", (req, res) => {
  const { host, port = 22, username, password } = req.body;

  let responded = false;

  if (!host || !username || !password) {
    return res.status(400).json({
      success: false,
      error: "host, username and password are required",
    });
  }

  const ssh = new SSHClient();
  const sessionId = uuidv4();
  ssh.on("ready", () => {
    ssh.shell((err, stream) => {
      if (err) {
        if (!responded) {
          responded = true;
          return res.status(500).json({ success: false, error: err.message });
        }
      }

      sessions[sessionId] = { type: "ssh", conn: ssh, stream, output: [] };
      let loginStage = 0; // 0 = not started, 1 = sent username, 2 = sent password

      stream.on("data", (data) => {
        const out = data.toString();
        sessions[sessionId].output.push(out);

        // Normalize output (remove CR/LF for matching)
        const clean = out.trim().toLowerCase();

        if (
          loginStage === 0 &&
          (clean.endsWith("username:") || clean.endsWith("user name:"))
        ) {
          stream.write(username + "\n");
          loginStage = 1;
        } else if (loginStage === 1 && clean.endsWith("password:")) {
          stream.write(password + "\n");
          loginStage = 2;
        }
      });

      res.json({ success: true, sessionId });
    });
  });

  // Also handle keyboard-interactive (some switches need this)
  ssh.on(
    "keyboard-interactive",
    (name, instructions, lang, prompts, finish) => {
      finish([password]);
    }
  );

  ssh.on("error", (err) => {

    // if we already sent a response → push error into SSE output
    if (sessions[sessionId]) {
      sessions[sessionId].output.push(`❌ SSH Error: ${err.message}\n`);
    } else if (!responded) {
      responded = true;
      res.status(200).json({ success: false, error: err.message });
    }
  });

  // Connect with both password + keyboard fallback
  ssh.connect({
    host,
    port,
    username,
    password,
    tryKeyboard: true,
    algorithms: {
      kex: [
        "diffie-hellman-group1-sha1",
        "diffie-hellman-group14-sha1",
        "diffie-hellman-group-exchange-sha1",
        "diffie-hellman-group-exchange-sha256",
      ],
      cipher: [
        "aes128-ctr",
        "aes192-ctr",
        "aes256-ctr",
        "aes128-cbc",
        "3des-cbc",
      ],
      hmac: ["hmac-sha1", "hmac-md5"],
      serverHostKey: ["ssh-rsa", "ssh-dss"],
    },
  });
});

/**
 * TELNET CONNECT (raw, no username/password)
 */
app.post("/telnet/connect", async (req, res) => {
  const { host, port = 23, password } = req.body;
  const connection = new Telnet();
  const sessionId = uuidv4();

  try {
    await connection.connect({
      host,
      port,
      timeout: 10000,
      negotiationMandatory: false,
      password: password,
    });

    sessions[sessionId] = { type: "telnet", conn: connection, output: [] };

    connection.on("data", (data) => {
      sessions[sessionId].output.push(data.toString());
    });

    res.json({ success: true, sessionId });
  } catch (err) {
    res.status(200).json({ success: false, error: err.message });
  }
});

/**
 * SEND RAW INPUT
 */
app.post("/send", (req, res) => {
  const { sessionId, input } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Invalid session" });

  if (session.type === "telnet") {
    session.conn.send(input);
  } else if (session.type === "ssh") {
    session.stream.write(input.trim() + "\r\n");
  }

  res.json({ success: true });
});

/**
 * SSE STREAM
 */
app.get("/stream/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  if (!session) return res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  let lastIndex = 0;

  const interval = setInterval(() => {
    if (!sessions[sessionId]) {
      clearInterval(interval);
      res.end();
      return;
    }

    const { output } = sessions[sessionId];
    if (output.length > lastIndex) {
      const newData = output.slice(lastIndex).join("");
      res.write(`data: ${JSON.stringify(newData)}\n\n`);
      lastIndex = output.length;
    }
  }, 300);

  req.on("close", () => clearInterval(interval));
});

/**
 * DISCONNECT
 */
app.post("/disconnect", (req, res) => {
  const { sessionId } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Invalid session" });

  if (session.type === "telnet") {
    session.conn.end();
  } else if (session.type === "ssh") {
    session.conn.end();
  }

  delete sessions[sessionId];
  res.json({ success: true });
});

app.post("/run", (req, res) => {
  const { sessionId, command } = req.body;
  const session = sessions[sessionId];
  if (!session) {
    return res.status(404).json({ success: false, error: "Invalid session" });
  }

  let outputBuffer = "";
  let finished = false;
  let timeout;

  const cleanup = () => {
    if (session.type === "ssh") {
      session.stream.removeListener("data", handleData);
    } else {
      session.conn.removeListener("data", handleData);
    }
    clearTimeout(timeout);
  };

  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(onTimeout, 5000); // idle timeout
  };

  const onTimeout = () => {
    if (!finished) {
      finished = true;
      cleanup();
      res.json({ success: true, output: outputBuffer });
    }
  };

  const handleData = (data) => {
    let text = data.toString();

    // Reset idle timeout on every chunk
    resetTimeout();

    // Handle paging
    if (/--More--|More:|<--- More --->/i.test(text)) {
      if (session.type === "ssh") {
        session.stream.write(" ");
      } else if (session.type === "telnet") {
        session.conn.send(" ");
      }
      // Remove pager lines (Cisco/Huawei/Juniper/HP)
      text = text.replace(
        /^(.*(--More--|More:|<--- More --->|<space>|CTRL\+Z|<return>).*\r?\n?)/gim,
        ""
      );

      // 2. Remove ANSI escape sequences
      text = text.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "");
    }

    outputBuffer += text;

    // Detect end prompt (#, >, $)
    const cleanText = text.trim();

    // Detect prompt (must end with >, #, or $)
    const isPrompt = /\S+[>#\$]$/.test(cleanText);

    // Detect pager hints we want to ignore
    const isPagerHint = /<space>|CTRL\+Z|<return>/i.test(cleanText);

    if (isPrompt && !isPagerHint) {
      if (!finished) {
        finished = true;
        cleanup();

        if (
          /not found/i.test(outputBuffer) ||
          /command not found/i.test(outputBuffer) ||
          /invalid input/i.test(outputBuffer) ||
          outputBuffer.trim().length < 20
        ) {
          return res.json({ success: false, output: outputBuffer });
        }

        return res.json({ success: true, output: outputBuffer });
      }
    }
  };

  if (session.type === "ssh") {
    session.stream.on("data", handleData);
    session.stream.write(command.trim() + "\r\n");
  } else if (session.type === "telnet") {
    session.conn.on("data", handleData);
    session.conn.send(command.trim() + "\r\n");
  }

  resetTimeout(); // start timeout
});

const PORT = 4000;
app.listen(PORT, () => console.log(`HTTP terminal bridge running on ${PORT}`));
