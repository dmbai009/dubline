// Same production ASAR/runtime, isolated NSIS registry identity and shortcuts.
// This lets installer UI/update QA coexist with a real Dubline installation.
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { nextTestVersion, isBeta } = require('../src/update-version');
const root = path.resolve(__dirname, '..'), a = require('../package.json').version, b = nextTestVersion(a);
const qaRoot = path.join(root, 'build', 'update-qa', 'setup-isolated');
fs.mkdirSync(qaRoot, { recursive:true });
const include = path.join(qaRoot, 'installer-qa.nsh');
const original = fs.readFileSync(path.join(__dirname,'installer.nsh'), 'utf8');
const source = original.replace('"io.github.dmbai009.Dubline.Setup.Project"', '"io.github.dmbai009.Dubline.QASetup.Project"');
if (source === original) throw Error('Missing installer handler identity.');
fs.writeFileSync(include,'!define /redef APP_INSTALLER_STORE_FILE "Dubline-setupqa-updater\\installer.exe"\n' + source,'utf8');
for (const [version, unpacked] of [[a,path.join(root,'dist','win-unpacked')],[b,path.join(root,'build','update-qa',b,'win-unpacked')]]) {
  const args = [require.resolve('electron-builder/cli'),'--win','nsis','--x64','--prepackaged',unpacked,'--publish','never',
    '--config.appId=io.github.dmbai009.dubline.setupqa',
    '--config.extraMetadata.version=' + version,
    '--config.publish.channel=' + (isBeta(version) ? 'beta' : 'latest'),
    '--config.directories.output=' + path.join(qaRoot,version),
    '--config.nsis.include=' + include,
    '--config.nsis.shortcutName=Dubline Setup QA',
    '--config.nsis.uninstallDisplayName=Dubline Setup QA'];
  const result=spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',windowsHide:true});
  if(result.error)throw result.error; if(result.status!==0)throw Error('Isolated Setup build failed.');
}
