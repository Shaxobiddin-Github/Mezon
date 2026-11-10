export default async function beforeBuild() {
  // Staged dist-app/node_modules is pre-collected, dereferenced, and ABI-verified by prepare-electron-app.mjs.
  return false;
}
