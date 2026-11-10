// Runs before every npm script. Plain JavaScript on purpose: it has to work on the very
// Node versions it is here to turn away. The app stores its memory with node:sqlite, which is
// built into Node from 22.13 on; on anything older the import fails with an unhelpful error.

const [major, minor] = process.versions.node.split(".").map(Number);

if (major < 22 || (major === 22 && minor < 13)) {
  console.error(
    `\n  This app needs Node.js 22.13 or newer. You are running ${process.versions.node}.\n` +
      `  Install a current release from https://nodejs.org (or run "nvm install 22"), then try again.\n`,
  );
  process.exit(1);
}
