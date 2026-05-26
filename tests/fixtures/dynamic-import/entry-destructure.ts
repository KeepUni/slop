export async function run(): Promise<void> {
  const { init } = await import("./feature.js");
  init();
}
