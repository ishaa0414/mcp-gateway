import type { NextConfig } from 'next'

const config: NextConfig = {
  // The e2e run builds into its own folder (apps/e2e, NEXT_DIST_DIR=.next-e2e) so a build never overwrites what next dev uses.
  distDir: process.env['NEXT_DIST_DIR'] || '.next',
}
export default config
