# 🖥️ Device Terminal Backend

This backend provides a **unified HTTP bridge** for interacting with network devices (Cisco, Huawei, Juniper, etc.) or servers over **SSH** and **Telnet**.  
It supports:

- 🔑 Username/password authentication (SSH & Telnet)  
- 📡 Real-time terminal output via **Server-Sent Events (SSE)**  
- ⌨️ Sending raw commands  
- 📥 Downloading full device configurations (handles paging: `--More--`, `More:`, `<space> Quit`, etc.)  
- 🧹 Cleans pager junk (`--More--`, `<return>` hints) and ANSI escape codes  

---

## 📦 Installation

Clone the repo and install dependencies:

```bash
git clone <your-repo-url>
cd backend
npm install
```

---

## 🚀 Running

Start the backend:

```bash
node server.js
```

By default, it runs on **http://localhost:4000**.

---

## ⚡ API Endpoints

### 1. **Connect (SSH)**

```http
POST /ssh/connect
```

**Body:**
```json
{
  "host": "192.168.0.125",
  "port": 22,
  "username": "admin",
  "password": "password123"
}
```

**Response:**
```json
{ "success": true, "sessionId": "uuid-1234" }
```

---

### 2. **Connect (Telnet)**

```http
POST /telnet/connect
```

**Body:**
```json
{
  "host": "192.168.0.125",
  "port": 23,
  "username": "admin",
  "password": "password123"
}
```

**Response:**
```json
{ "success": true, "sessionId": "uuid-5678" }
```

---

### 3. **Stream Output (SSE)**

```http
GET /stream/:sessionId
```

Frontend usage:
```js
const evt = new EventSource("http://localhost:4000/stream/<sessionId>");
evt.onmessage = (event) => console.log(event.data);
```

---

### 4. **Send Input**

```http
POST /send
```

**Body:**
```json
{
  "sessionId": "uuid-1234",
  "input": "show version"
}
```

---

### 5. **Run & Download Config**

```http
POST /run
```

Automatically sends the appropriate command for the vendor and captures the full configuration (auto-presses space for `--More--`).

**Body:**
```json
{
  "sessionId": "uuid-1234",
  "command": "show running-config"
}
```

**Response:**
```json
{
  "success": true,
  "output": "interface GigabitEthernet0/0\n ip address 192.168.1.1 255.255.255.0\n..."
}
```

---

### 6. **Disconnect**

```http
POST /disconnect
```

**Body:**
```json
{
  "sessionId": "uuid-1234"
}
```

---

## 🧹 Output Sanitization

The backend automatically strips:

- Pager hints:
  - `--More--`
  - `More:`
  - `<--- More --->`
  - `<space>, Quit: q or CTRL+Z, One line: <return>`
  - `More: <space>, Quit: q or CTRL+Z, One line: <return>`
- ANSI escape sequences (`[0m`, `[32m`, etc.)  

Ensuring that downloaded configuration files are **clean plain text**.

---

## 🛠️ Notes

- Works with Cisco, Huawei, Juniper, HP switches/routers, and Linux/Unix servers.  
- SSH supports legacy algorithms (e.g., `diffie-hellman-group1-sha1`, `ssh-dss`) for old devices.  
- Timeout fallback ensures commands won’t hang forever.  

---

## 📜 License

MIT License © Paraqum Technologies  
