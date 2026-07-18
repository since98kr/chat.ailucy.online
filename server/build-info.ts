export type BuildInfo = {
  service: 'chat-ailucy-v2';
  version: string;
  sha: string;
  builtAt: string;
  environment: string;
};

export function getBuildInfo(): BuildInfo {
  return {
    service: 'chat-ailucy-v2',
    version: process.env.CHAT_VERSION?.trim() || '0.5.0-dev',
    sha: process.env.CHAT_BUILD_SHA?.trim() || 'development',
    builtAt: process.env.CHAT_BUILD_TIME?.trim() || 'unknown',
    environment: process.env.CHAT_ENVIRONMENT?.trim() || process.env.NODE_ENV || 'development',
  };
}
