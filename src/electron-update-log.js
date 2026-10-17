const fs = require('node:fs'), path = require('node:path');
class UpdateLog {
  constructor(folder, distribution) {
    this.file = path.join(folder, 'application-update-log.json');
    this.distribution = distribution; this.events = []; this.job = Promise.resolve(); this.lastAt = 0;
    try { if (fs.statSync(this.file).size <= 256 * 1024) this.events = JSON.parse(fs.readFileSync(this.file,'utf8')).events.slice(-127); } catch { /* first launch/log corruption is nonfatal */ }
  }
  record(status) {
    const now = Date.now();
    if (status.state === this.lastState && now - this.lastAt < 1000) return;
    this.lastState = status.state; this.lastAt = now;
    const event = { at: new Date(now).toISOString(), channel:this.distribution.channel, currentVersion:this.distribution.version,
      targetVersion:status.version || '', state:status.state, strategy:status.downloadKind || (this.distribution.channel === 'github-setup' ? 'electron-updater' : ''),
      bytesDownloaded:Math.max(0,Math.round(Number(status.progress?.transferred) || 0)), integrity:status.state === 'downloaded' ? 'verified' : '',
      recovered:status.recovered === true, helperLine:Number(status.helperLine) || 0 };
    this.events.push(event); this.events=this.events.slice(-128);
    const snapshot=JSON.stringify({schemaVersion:1,events:this.events});
    this.job=this.job.catch(()=>{}).then(async()=>{
      await fs.promises.mkdir(path.dirname(this.file),{recursive:true});
      const temporary=this.file+'.new';await fs.promises.writeFile(temporary,snapshot);await fs.promises.rename(temporary,this.file);
    }).catch(()=>{});
  }
}
module.exports={UpdateLog};
