import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

const app = {
  url: 'http://127.0.0.1:8642',
  command: {
    executable: 'npm',
    args: ['start'],
    reuseExisting: true,
  },
};

export default {
  tests: ['e2e/**/*.e2e.ts'],
  targets: [{ name: 'chromium', engine: web(), app }],
} satisfies E2EConfig;
