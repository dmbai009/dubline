// Real OS-backed migration, native IPC and preloads; only OS picker responses are mocked.
process.env.DUBLINE_NATIVE_STORAGE_TEST = '1';
require('./electron-project-smoke');
