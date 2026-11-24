import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

writeFileSync(process.env.PARENT, String(process.pid), { flag: 'wx' });
const grandchildCode = `const fs=require('node:fs');fs.writeFileSync(process.env.GRAND,String(process.pid),{flag:'wx'});setInterval(()=>{},1000);`;
const childCode = `const fs=require('node:fs');const cp=require('node:child_process');fs.writeFileSync(process.env.CHILD,String(process.pid),{flag:'wx'});cp.spawn(process.execPath,['-e',${JSON.stringify(grandchildCode)}],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000);`;
spawn(process.execPath, ['-e', childCode], { stdio: 'ignore', windowsHide: true });
setTimeout(() => process.exit(0), 1200);
