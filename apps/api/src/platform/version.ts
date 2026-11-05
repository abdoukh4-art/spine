/** Spine's version (set by the image build, see api.Dockerfile), for telemetry and exports. */
export function spineVersion(): string {
  return process.env.SPINE_VERSION ?? process.env.npm_package_version ?? '0.0.0-dev';
}
