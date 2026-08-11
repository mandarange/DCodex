export interface CapabilityCard {
  id: string
  tier: 'orchestrator' | 'worker'
  supports_images: boolean
  supports_write: boolean
  supports_research: boolean
  reliability: number
  latency_cost: number
  token_cost: number
  mutation_risk_cost: number
  model_price_cost: number
  queue_pressure_cost: number
}

export const DEFAULT_CAPABILITY_CARDS: CapabilityCard[] = [
  {
    id: 'fast-worker',
    tier: 'worker',
    supports_images: false,
    supports_write: true,
    supports_research: false,
    reliability: 0.82,
    latency_cost: 1,
    token_cost: 1,
    mutation_risk_cost: 1,
    model_price_cost: 1,
    queue_pressure_cost: 1
  },
  {
    id: 'vision-worker',
    tier: 'worker',
    supports_images: true,
    supports_write: true,
    supports_research: false,
    reliability: 0.86,
    latency_cost: 2,
    token_cost: 2,
    mutation_risk_cost: 1,
    model_price_cost: 2,
    queue_pressure_cost: 2
  },
  {
    id: 'research-worker',
    tier: 'worker',
    supports_images: false,
    supports_write: false,
    supports_research: true,
    reliability: 0.84,
    latency_cost: 2,
    token_cost: 2,
    mutation_risk_cost: 0,
    model_price_cost: 2,
    queue_pressure_cost: 2
  },
  {
    id: 'balanced-orchestrator',
    tier: 'orchestrator',
    supports_images: true,
    supports_write: true,
    supports_research: true,
    reliability: 0.9,
    latency_cost: 3,
    token_cost: 3,
    mutation_risk_cost: 2,
    model_price_cost: 3,
    queue_pressure_cost: 2
  },
  {
    id: 'strong-orchestrator',
    tier: 'orchestrator',
    supports_images: true,
    supports_write: true,
    supports_research: true,
    reliability: 0.95,
    latency_cost: 5,
    token_cost: 5,
    mutation_risk_cost: 3,
    model_price_cost: 5,
    queue_pressure_cost: 4
  }
]

export function capabilityCost(card: CapabilityCard) {
  return card.latency_cost
    + card.token_cost
    + card.mutation_risk_cost
    + card.model_price_cost
    + card.queue_pressure_cost
}
