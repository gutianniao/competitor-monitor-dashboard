declare module 'wappalyzer-wrapper' {
  const wappalyzerWrapper: { analyze(input: Record<string, unknown>): unknown; apps: unknown; categories: unknown };
  export default wappalyzerWrapper;
}
