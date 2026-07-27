import { config } from "dotenv";

// Load ONLY the test DB config — never the app's .env. override:true so .env.test
// definitively wins over any inherited DATABASE_URL. The integration suite
// migrates/seeds/TRUNCATEs, so it must point exclusively at a disposable DB; by
// loading only .env.test it can never accidentally reach the dev/production database.
config({ path: ".env.test", override: true });
