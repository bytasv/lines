/**
 * Ad-hoc sign the packed app bundle.
 *
 * electron-builder's `identity: null` does not mean "sign ad-hoc" — it means
 * skip bundle signing entirely (`skipped macOS code signing`). What survives is
 * only the linker's ad-hoc signature on the Mach-O, which *declares* sealed
 * resources while nothing seals them: no `Contents/_CodeSignature/CodeResources`.
 * macOS reports that as
 *
 *   "Lines" is damaged and can't be opened. You should move it to the Bin.
 *
 * which is unrecoverable from the UI — unlike the unidentified-developer case,
 * a "damaged" bundle gets no "Open Anyway" button in Privacy & Security. So
 * every download was a dead end until the bundle carried a real seal.
 *
 * Runs at afterPack, i.e. after the bundle is assembled but before the DMG and
 * zip are built from it, so both artifacts inherit the signature.
 *
 * This is still ad-hoc: not notarized, so a browser download is quarantined and
 * Gatekeeper will refuse it until the user allows it. It fixes "damaged", not
 * quarantine — only a Developer ID and notarization fix that. When one exists,
 * delete this hook and set a real `identity` instead.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  // --deep because the bundle nests helpers and frameworks that each need
  // sealing; --force to replace the linker's resource-less signature.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });
  // Fail the build rather than ship another "damaged" DMG: this is the exact
  // check whose absence made the first release uninstallable.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' });
  console.log(`  • ad-hoc signed and verified  ${appName}`);
}
