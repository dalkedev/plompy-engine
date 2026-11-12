import { loadConfig } from './src/config.mjs';
import { startServer } from './src/server.mjs';

let instance;
try {
  const config=await loadConfig();
  instance=await startServer(config);
  console.log(`Plompy Local listening on port ${config.server.port}. Research tools only; no Discord or model account required.`);
} catch {
  console.error('Plompy Local could not start. Run the local init/status commands and check private config, credential permissions and port availability.');
  process.exitCode=1;
}
if(instance)for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await instance.close();process.exitCode=0;});
