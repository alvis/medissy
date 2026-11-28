/**
 * reading urlencoded form bodies; every value is untrusted text; callers
 * validate it against the sharing contracts before use
 */
import type { FastifyRequest } from 'fastify';

/**
 * returns the body as a field map, or empty when it is not a form
 * @param request the form post request
 * @returns the fields
 */
function bodyOf(request: FastifyRequest): Record<string, unknown> {
  const { body } = request;

  return typeof body === 'object' && body !== null
    ? (body as Record<string, unknown>)
    : {};
}

/**
 * reads one text field
 * @param request the form post request
 * @param name which field to read
 * @returns the value, or '' when absent or repeated
 */
export function field(request: FastifyRequest, name: string): string {
  const value = bodyOf(request)[name];

  return typeof value === 'string' ? value : '';
}

/**
 * reads a repeatable field (checkbox group)
 * @param request the form post request
 * @param name the field name
 * @returns every value given
 */
export function fields(request: FastifyRequest, name: string): string[] {
  const value = bodyOf(request)[name];

  if (typeof value === 'string') {
    return [value];
  }

  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

/**
 * reads a route parameter
 * @param request the request carrying the route parameters
 * @param name the parameter name
 * @returns the value, or ''
 */
export function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown> | undefined)?.[name];

  return typeof value === 'string' ? value : '';
}

/**
 * reads a whole number field within bounds
 * @param request the form post request
 * @param name the field name
 * @param allowed the accepted values
 * @returns the number, or undefined when not one of `allowed`
 */
export function choice(
  request: FastifyRequest,
  name: string,
  allowed: readonly number[],
): number | undefined {
  const value = Number(field(request, name));

  return allowed.includes(value) ? value : undefined;
}
