/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder afterSign hook.
 *
 * Notarizes the macOS app only when Apple notarization credentials are
 * present in the environment. This keeps local/dev builds fast (no
 * notarization) while enabling CI to produce notarized releases by simply
 * setting APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID secrets.
 *
 * electron-builder's built-in `mac.notarize` is set to false in
 * electron-builder.yml so that builds without credentials do not fail;
 * this hook performs the notarization step explicitly when credentials exist.
 */
const { notarize } = require('@electron/notarize');

module.exports = async function afterSign(context) {
  const platform = context.packager.platform.name;
  if (platform !== 'mac' && platform !== 'darwin') {
    return;
  }

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[afterSign] Apple notarization credentials not set, skipping notarization');
    return;
  }

  const appOutDir = context.appOutDir;
  const productName = context.packager.appInfo.productName || 'DUYA';
  const appBundleId = context.packager.config.appId || 'com.duya.app';
  const appPath = require('path').join(appOutDir, `${productName}.app`);

  console.log(`[afterSign] Notarizing ${appPath} (bundleId=${appBundleId})...`);
  await notarize({
    appBundleId,
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[afterSign] Notarization complete');
};
