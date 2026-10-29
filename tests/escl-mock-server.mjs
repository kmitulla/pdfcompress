// Eigenständiger Test-Scanner für die Playwright-Testumgebung (Port 8861).
import { startMockScanner } from './escl-mock.mjs';

const port = parseInt(process.env.MOCK_PORT, 10) || 8861;
await startMockScanner({ port });
console.log(`eSCL-Testscanner auf http://127.0.0.1:${port}`);
