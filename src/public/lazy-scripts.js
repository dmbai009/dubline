(() => {
  const jobs = new Map();
  function load(path) {
    if (jobs.has(path)) return jobs.get(path);
    const job = new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = path;
      const timer = setTimeout(() => { script.remove(); reject(new Error('Script loading timed out')); }, 15000);
      script.onload = () => { clearTimeout(timer); resolve(); };
      script.onerror = () => { clearTimeout(timer); script.remove(); reject(new Error('Script could not be loaded')); };
      document.head.append(script);
    }).catch(error => { jobs.delete(path); throw error; });
    jobs.set(path, job); return job;
  }
  window.DublineLazyScripts = { load, jszip: async () => { if (!window.JSZip) await load('/vendor/jszip/jszip.min.js'); if (!window.JSZip) throw new Error('ZIP support is unavailable'); return window.JSZip; } };
})();
