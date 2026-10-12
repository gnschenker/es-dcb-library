export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@opentelemetry/api') {
    throw new Error('blocked @opentelemetry/api');
  }
  return nextResolve(specifier, context);
}
