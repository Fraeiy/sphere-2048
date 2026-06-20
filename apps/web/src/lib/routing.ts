/** After wallet connect / session restore — skip deposit when moves remain. */
export function routeForMoveBalance(creditsRemaining: number): '/play' | '/deposit' {
  return creditsRemaining > 0 ? '/play' : '/deposit';
}