export function readCargoWorkspaceVersion(root: string): string;
export function releaseVersionRefusals(root: string): Array<{
  readonly code: string;
  readonly where: string;
  readonly message: string;
}>;
