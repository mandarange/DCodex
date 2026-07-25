#!/usr/bin/env node
// @ts-nocheck
import { assertGate, emitGate, importDist } from './gate-lib.js';

const routes = await importDist('core/routes.js');
const commandFor = (prompt) => routes.routePrompt(prompt)?.command;
assertGate(commandFor('$SEO-GEO-OPTIMIZER improve AI answer visibility') === '$SEO-GEO-OPTIMIZER', 'explicit optimizer should route to unified route');
assertGate(commandFor('Generative Engine Optimization crawler policy audit') === '$SEO-GEO-OPTIMIZER', 'generative engine optimization should route to unified optimizer');
assertGate(commandFor('SEO audit canonical sitemap metadata') === '$SEO-GEO-OPTIMIZER', 'SEO intent should route to unified optimizer');
assertGate(commandFor('fix GeoIP regional redirect bug') !== '$SEO-GEO-OPTIMIZER', 'GeoIP/geolocation request must not route to optimizer');
assertGate(commandFor('map coordinates and location permission issue') !== '$SEO-GEO-OPTIMIZER', 'location permission request must not route to optimizer');

emitGate('seo-geo:geo-disambiguation');
