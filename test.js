const { spawn } = require('child_process');

// Switch between 'ssh' or 'telnet' depending on what you need:
const command = 'telnet';                 // or 'ssh'
const args    = ['192.168.1.148', '23'];    // telnet host port
// const args = ['user@example.com'];     // ssh example

const child = spawn(command, args, {
  stdio: 'inherit',   // pipe user’s terminal I/O directly
  shell: true         // helps Windows find telnet/ssh
});

child.on('exit', code => {
  console.log(`Session closed with code ${code}`);
});
