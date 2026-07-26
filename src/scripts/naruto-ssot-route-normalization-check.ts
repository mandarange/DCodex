#!/usr/bin/env node
import { assertGate, emitGate, importDist } from './gate-lib.js'

const routes = await importDist('core/routes.js')
const removedTeam = routes.routePrompt('$Team fix a release bug')
const explicitNaruto = routes.routePrompt('$Naruto fix a release bug')

assertGate(removedTeam === null, 'removed $Team prompt must not normalize or redirect')
assertGate(explicitNaruto?.id === 'Naruto', '$Naruto prompt must resolve to Naruto')
emitGate('naruto:ssot-route-normalization', { removed_team: removedTeam, naruto: explicitNaruto?.id })
