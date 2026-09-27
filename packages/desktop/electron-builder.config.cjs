// electron-builder 진입 설정. 로직은 builder/config.cjs(테스트됨)에 있다.
const { buildConfig, signingWarnings } = require('./builder/config.cjs');

for (const warning of signingWarnings(process.env)) console.warn(`[aeyes-agent-desktop] 경고: ${warning}`);

module.exports = buildConfig(process.env);
