const { Client } = require("ssh2");
const net = require("net");

// Telnet negotiation constants
const IAC = 255;
const DO = 253;
const DONT = 254;
const WILL = 251;
const WONT = 252;

// Handle telnet negotiations
function negotiate(data, socket) {
  for (let i = 0; i < data.length; i++) {
    if (data[i] === IAC) {
      const command = data[i + 1];
      const option = data[i + 2];
      if (command === DO) {
        socket.write(Buffer.from([IAC, WONT, option]));
      } else if (command === WILL) {
        socket.write(Buffer.from([IAC, DONT, option]));
      }
      i += 2; // skip over command + option
    }
  }
}

function handleSession(ws) {
  let ssh = null;
  let telnet = null;

  ws.on("message", async (message) => {
    try {
      const raw = message.toString();

      // Handle JSON "connect" message
      if (raw.startsWith("{")) {
        const data = JSON.parse(raw);
        if (data.type === "connect") {
          const { type, host, port, username, password } = data.payload;

          // ✅ SSH connection
          if (type === "ssh") {
            ssh = new Client();
            ssh.on("ready", () => {
              ws.send("[SSH] ✅ Connected\n");
              ssh.shell({ term: "vt100" }, (err, stream) => {
                if (err) {
                  ws.send(`[SSH] ❌ Shell error: ${err.message}\n`);
                  return;
                }

                // Forward Cisco output to the browser
                stream
                  .on("data", (chunk) => ws.send(chunk.toString()))
                  .on("close", () => ssh.end());

                // Only one message listener for commands
                ws.on("message", (input) => {
                  const cmd = input.toString();
                  if (!cmd.startsWith("{")) {
                    // Cisco wants carriage return
                    stream.write(cmd.replace(/\n$/, "") + "\r");
                  }
                });
              });
            });
          }

          // ✅ Telnet connection (raw with negotiation)
          if (type === "telnet") {
            telnet = new net.Socket();

            telnet.connect(port || 23, host, () => {
              ws.send(`[Telnet] ✅ Connected to ${host}:${port}\n`);
              console.log(`[Telnet] ✅ Connected to ${host}:${port}\n`);
              telnet.write("\r\n"); // kickstart banner if needed
            });

            telnet.on("data", (data) => {
              negotiate(data, telnet);

              const output = data
                .toString("utf8")
                .replace(/\xFF[\s\S]{2}/g, ""); // strip IAC codes
              ws.send(output);

              // Auto login handling
              if (output.includes("paraqum login:")) {
                telnet.write(username + "\r\n");
              } else if (output.toLowerCase().includes("password:")) {
                telnet.write(password + "\r\n");
              }
            });

            telnet.on("error", (err) => {
              ws.send(`[Telnet] ❌ Error: ${err.message}\n`);
            });

            telnet.on("close", () => {
              ws.send("[Telnet] 🔌 Connection closed\n");
            });

            // Forward frontend commands after login
            ws.on("message", (input) => {
              const cmd = input.toString();
              if (!cmd.startsWith("{")) {
                telnet.write(cmd + "\r\n");
              }
            });
          }
        }
      }
    } catch (err) {
      ws.send(`❌ Error: ${err.message}\n`);
    }
  });

  // Cleanup on disconnect
  ws.on("close", () => {
    if (ssh) ssh.end();
    if (telnet) telnet.end();
  });
}

module.exports = { handleSession };
