import { MAX_POINT_LIGHTS, MAX_SPOT_LIGHTS, MAX_AREA_LIGHTS } from './light-limits.js';

const DRAWN_LIGHT_LISTS = [['pointLights', MAX_POINT_LIGHTS], ['spotLights', MAX_SPOT_LIGHTS], ['areaLights', MAX_AREA_LIGHTS]];

/**
 * The environment with each light list cut to what a drawn frame takes: the first lights of each kind that fit. For a page
 * whose picture is path traced from the full lists while its renderer only has to start. An environment that already fits
 * is returned as it is.
 */
export function withinDrawnLightLimits(environment) {
  const tooLong = DRAWN_LIGHT_LISTS.filter(([field, maximum]) => Array.isArray(environment[field]) && environment[field].length > maximum);
  if (tooLong.length === 0) return environment;
  const drawn = { ...environment };
  for (const [field, maximum] of tooLong) {
    drawn[field] = environment[field].slice(0, maximum);
  }
  return drawn;
}
