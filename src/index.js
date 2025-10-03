const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const { Telnet } = require("telnet-client");
const { Client: SSHClient } = require("ssh2");
const { v4: uuidv4 } = require("uuid");
const TelnetStream = require("telnet-stream");
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
app.post("/api/ssh/connect", (req, res) => {
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
      responded = true;
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
      console.log(err.message)
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
const net = require("net");

const { TelnetSocket } = require("telnet-stream");

app.post("/api/telnet/connect", (req, res) => {
  const { host, port = 23, username, password } = req.body;
  const socket = net.createConnection(port, host);

  // Wrap with TelnetSocket
  const telnet = new TelnetSocket(socket);

  const sessionId = uuidv4();
  sessions[sessionId] = { type: "telnet", conn: socket, output: [] };

  let loginStage = 0;

  telnet.on("data", (data) => {
    const text = data.toString("utf8");
    console.log("TELNET:", text);
    sessions[sessionId].output.push(text);

    if (loginStage === 0 && /(username|user name|login)\s*:/i.test(text)) {
      telnet.write(username + "\r\n");
      loginStage = 1;
    } else if (loginStage === 1 && /password\s*:/i.test(text)) {
      telnet.write(password + "\r\n");
      loginStage = 2;
    } else if (loginStage === 2 && /[$#>\]]\s*$/m.test(text.trim())) {
      console.log("✅ Logged in");
      loginStage = 3;
    }
  });

  // Negotiate: refuse all options
  telnet.on("do", (option) => telnet.writeWont(option));
  telnet.on("will", (option) => telnet.writeDont(option));

  socket.on("connect", () => {
    console.log(`[TELNET][${host}] Connected`);
    res.json({ success: true, sessionId });
  });

  socket.on("close", () => {
    console.log(`[TELNET][${host}] Connection closed`);
    delete sessions[sessionId];
  });

  socket.on("error", (err) => {
    console.error(`[TELNET][${host}] ERROR: ${err.message}`);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
    sessions[sessionId].output.push(`❌ ERROR: ${err.message}\n`);
  });
});


/**
 * SEND RAW INPUT
 */
app.post("/api/send", (req, res) => {
  const { sessionId, input } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Invalid session" });

  if (session.type === "telnet") {
     session.conn.write(input.trim() + "\r\n");
  } else if (session.type === "ssh") {
    session.stream.write(input.trim() + "\r\n");
  }

  res.json({ success: true });
});

/**
 * SSE STREAM
 */
app.get("/api/stream/:sessionId", (req, res) => {
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
app.post("/api/disconnect", (req, res) => {
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



/**
 * DOWNLOAD FULL CONFIGURATION (Telnet with character-mode fix)
 */
app.post("/api/run", async (req, res) => {
 const { host, port = 23, username, password, vendor = 99, timeout = 20000,enablePassword } = req.body || {};
  if (!host || !username || !password || !enablePassword) {
    return res.status(400).json({
      success: false,
      message: "host, username, password, vendor required",
    });
  }

  const command = configCommand[vendor] || configCommand[99];
  const tn = new Telnet();
  let stage = "login"; // login -> enable -> command -> done
  let outputBuffer = "";
  let finished = false;
  let idleTimer;
  let capture = false;
  const EOL = "\r";

  // --- Helpers ---
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      console.log(`[TELNET][${host}] Idle timeout → finishing`);
      finish(true, { output: outputBuffer });
    }, 5000);
  };

  const finish = (success, extra = {}) => {
    if (finished) return;
    finished = true;
    if (idleTimer) clearTimeout(idleTimer);
    try {
      tn.end();
    } catch {}
    res.json({ success, ...extra });
  };

  const fail = (message) => finish(false, { message, output: outputBuffer });

  const cleanupAnsi = (s) =>
    s
      .replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, "") // ANSI
      .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "") // non-printable
      .replace(/\r\n/g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();

  const stripPager = (s) =>
    s.replace(/^.*?(--More--|More:|<--- More --->|<space>|CTRL\+Z|<return>).*$/gim, "");

  const writeLine = (line, delayMs = 0) => {
    setTimeout(() => {
      console.log(`[TELNET][${host}] >>> ${JSON.stringify(line + EOL)}`);
      tn.write(line + EOL);
    }, delayMs);
  };

  const isShellPrompt = (text) => {
    const t = text.trim();
    if (/(username|user name|login|password)\s*:/i.test(t)) return false;
    return /[^\s]+([>#\]])$/.test(t); // Cisco >/#, Huawei ]/>, Juniper >/#, Unix $/# 
  };

  try {
    await tn.connect({
      host,
      port,
      timeout: 15000,
      negotiationMandatory: false,
      shellPrompt: "",
      execTimeout: 0,
      sendTimeout: 0,
      ors: "\r",
      irs: "\n",
    });

    console.log(`[TELNET][${host}] Connected (run-command)`);

    tn.on("data", (buf) => {
      let text = buf.toString("utf8");

      // clean junk
      text = stripPager(text);
      text = cleanupAnsi(text);

      // append only if capturing
      if (capture) outputBuffer += text;

      resetIdleTimer();

      const trimmed = text.trim();

      // --- LOGIN ---
      if (/(username|user name|login)\s*:/i.test(trimmed) && stage === "login") {
        
        writeLine(username, 200);
        return;
      }
      if (/password\s*:/i.test(trimmed) && stage === "login") {
        writeLine(password, 400);
        return;
      }

      // --- ENABLE PASSWORD ---
      if (/password\s*:/i.test(trimmed) && stage === "enable") {
        writeLine(enablePassword, 400);
        stage = "command";
        return;
      }

      // --- PAGER continue ---
      if (/--More--|More:|<--- More --->/i.test(buf.toString("utf8"))) {
        console.log(`[TELNET][${host}] Pager detected → sending space`);
        tn.write(" ");
        return;
      }

      // --- PROMPT ---
      if (isShellPrompt(text)) {
        console.log(`[TELNET][${host}] Prompt detected, stage=${stage}`);

        if (stage === "login") {
          if (trimmed.endsWith("$")) {
            return finish(false, { message: "Unsupported device (Unix shell)" });
          } else if (trimmed.endsWith("#")) {
            // Already privileged
            writeLine(command, 200);
            stage = "done";
            capture = true;
          } else if (trimmed.endsWith(">")) {
            if (vendor === 2) {
              // Cisco needs enable
              writeLine("enable", 200);
              stage = "enable";
            } else if (vendor === 3) {
              // Huawei can run directly
              writeLine(command, 200);
              stage = "done";
              capture = true;
            } else {
              // Default → run directly
              writeLine(command, 200);
              stage = "done";
              capture = true;
            }
          } else if (trimmed.endsWith("]")) {
            if (vendor === 3) {
              writeLine(command, 200);
              stage = "done";
              capture = true;
            }
          } else {
            return finish(false, { message: `Unsupported prompt: ${trimmed}` });
          }
        } else if (stage === "enable") {
          // If enable succeeded without password
          if (trimmed.endsWith("#")) {
            writeLine(command, 200);
            stage = "done";
            capture = true;
          }
        } else if (stage === "command") {
          console.log(`[TELNET][${host}] Sending command after enable: ${command}`);
          writeLine(command, 200);
          stage = "done";
          capture = true;
        } else if (stage === "done") {
          console.log(`[TELNET][${host}] Command complete → finishing`);
          return finish(true, { output: outputBuffer });
        }
      }
    });

    tn.on("close", () => {
      if (!finished) fail("Connection closed before completion");
    });

    tn.on("error", (err) => {
      if (!finished) fail(`Socket error: ${err.message}`);
    });

    // global timeout
    setTimeout(() => {
      if (!finished) fail(`Global timeout (${timeout / 1000}s)`);
    }, timeout);
  } catch (err) {
    console.error(`[TELNET][${host}] Connect ERROR: ${err.message}`);
    return res.status(500).json({ success: false, message: err.message });
  }
});
    
const configCommand = {
  1: "show running-config", // Generic
  2: "show running-config", // Cisco
  3: "display current-configuration", // Huawei
  4: "show configuration | display set", // Juniper
  99: "show running-config", // Others
};




const PORT = 4000;
app.listen(PORT, () => console.log(`HTTP terminal bridge running on ${PORT}`));
