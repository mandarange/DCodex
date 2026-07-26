#!/usr/bin/env node
import { assertGate, emitGate, importDist, readText } from './gate-lib.js'

const routes = await importDist('core/routes.js')
const removedTeam = routes.routePrompt('$Team fix the release gate')
const ordinaryWork = routes.routePrompt('implement a fix for the release gate')
const explicitNaruto = routes.routePrompt('$Naruto run release audit')
assertGate(removedTeam === null, '$Team must be absent instead of redirecting', removedTeam)
assertGate(ordinaryWork?.id === 'Naruto', 'ordinary implementation work must default to Naruto', ordinaryWork)
assertGate(explicitNaruto?.id === 'Naruto', '$Naruto must route to Naruto', explicitNaruto)
const routeSource = readText('src/core/routes.ts')
assertGate(!routeSource.includes("id: 'Team'") && !routeSource.includes("aliasTo: '$Naruto'"), 'removed Team route metadata must not remain in the route registry')
emitGate('naruto:ssot-routing', { removed_team: removedTeam, ordinary: ordinaryWork.id, naruto: explicitNaruto.id })
