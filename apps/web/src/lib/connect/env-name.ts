/**
 * The environment variable that holds a project's API key in the connection snippets. It is per project because
 * keys are per project: one shared name could not hold the keys of two projects.
 *
 * Upper-case, every character that is not a letter or digit becomes "_", then "_MCP_KEY"; a name that would start
 * with a digit gets "P_" in front (an environment variable cannot start with one).
 * petstore-demo gives PETSTORE_DEMO_MCP_KEY, and 3d-shop gives P_3D_SHOP_MCP_KEY.
 */
export function apiKeyEnvName(slug: string): string {
  const name = `${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_MCP_KEY`
  return /^[0-9]/.test(name) ? `P_${name}` : name
}
