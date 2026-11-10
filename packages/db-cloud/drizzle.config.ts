import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: process.env.DRIZZLE_OUT ?? './drizzle',
});
