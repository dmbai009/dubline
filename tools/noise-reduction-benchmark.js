// Compatibility entry point for the former benchmark command; RNNoise only.
const fs = require('node:fs'), path = require('node:path'), { spawnSync } = require('node:child_process');
const input = process.argv[2];
if (!input) throw Error('Provide a local speech file or a recordings folder.');
const files = fs.statSync(input).isDirectory() ? fs.readdirSync(input).filter(name => /\.(wav|webm|ogg|mp3)$/i.test(name)).slice(0,3).map(name => path.join(input,name)) : [input];
if (!files.length) throw Error('No supported local recordings found.');
for (const file of files) {
  const result = spawnSync(process.execPath, [path.join(__dirname,'rnnoise-audition.js'), path.resolve(file), path.resolve('audit/rnnoise/audition',path.parse(file).name)], { stdio:'inherit', windowsHide:true });
  if (result.status) process.exit(result.status);
}
