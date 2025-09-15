// index.js
const express = require("express");
const cors = require("cors");
const { Client } = require("ssh2");
const net = require("net");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 4000;
const sessions = {}; // keep track of SSH/Telnet sessions

// --- Telnet negotiation constants ---
const IAC = 255, DO = 253, DONT = 254, WILL = 251, WONT = 252;
function negotiate(data, socket) {
  for (let i = 0; i < data.length; i++) {
    if (data[i] === IAC) {
      const command = data[i + 1];
      const option = data[i + 2];
      if (command === DO) socket.write(Buffer.from([IAC, WONT, option]));
      else if (command === WILL) socket.write(Buffer.from([IAC, DONT, option]));
      i += 2;
    }
  }
}

// --- Connect endpoint ---
app.post("/connect", (req, res) => {
  const { type, host, port, username, password } = req.body;
  const id = Date.now().toString();
  sessions[id] = { output: [] };

  if (type === "ssh") {
    const ssh = new Client();
    sessions[id].ssh = ssh;

    ssh.on("ready", () => {
      sessions[id].output.push("[SSH] ✅ Connected\n");
      ssh.shell((err, stream) => {
        if (err) {
          sessions[id].output.push(`[SSH] ❌ Shell error: ${err.message}\n`);
          return;
        }
        sessions[id].stream = stream;

        stream.on("data", (chunk) =>
          sessions[id].output.push(chunk.toString())
        );
        stream.on("close", () => ssh.end());
      });
    })
    .on("error", (err) => {
      sessions[id].output.push(`[SSH] ❌ Connection error: ${err.message}\n`);
    })
    .connect({ host, port, username, password });
  }

  if (type === "telnet") {
    const telnet = new net.Socket();
    sessions[id].telnet = telnet;

    telnet.connect(port || 23, host, () => {
      sessions[id].output.push(`[Telnet] ✅ Connected to ${host}:${port}\n`);
      telnet.write("\r\n");
    });

    telnet.on("data", (data) => {
      negotiate(data, telnet);
      const output = data.toString("utf8").replace(/\xFF[\s\S]{2}/g, "");
      sessions[id].output.push(output);

      if (output.includes("login:")) telnet.write(username + "\r\n");
      else if (output.toLowerCase().includes("password:"))
        telnet.write(password + "\r\n");
    });

    telnet.on("close", () => sessions[id].output.push("[Telnet] 🔌 Connection closed\n"));
    telnet.on("error", (err) =>
      sessions[id].output.push(`[Telnet] ❌ Error: ${err.message}\n`)
    );
  }

  res.json({ id, status: "connecting" });
});

// --- Send command ---
app.post("/command/:id", (req, res) => {
  const { id } = req.params;
  const { command } = req.body;
  const session = sessions[id];

  if (!session) return res.status(404).json({ error: "Session not found" });

  if (session.stream) session.stream.write(command + "\n");
  if (session.telnet) session.telnet.write(command + "\r\n");

  res.json({ status: "sent" });
});

// --- Stream output (SSE) ---
app.get("/output/:id", (req, res) => {
  const { id } = req.params;
  const session = sessions[id];
  if (!session) return res.status(404).end();

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.flushHeaders();

  let lastIndex = 0;

  const interval = setInterval(() => {
    if (session.output.length > lastIndex) {
      const newData = session.output.slice(lastIndex).join("");
      res.write(`data: ${JSON.stringify(newData)}\n\n`);
      lastIndex = session.output.length;
    }
  }, 500);

  req.on("close", () => clearInterval(interval));
});

app.listen(PORT, () => console.log(`HTTP server running at http://localhost:${PORT}`));
