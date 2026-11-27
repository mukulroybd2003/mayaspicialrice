import type { Party } from '../types/erp';

export function computePartyDueAdvance(party: Party, viewMode: 'CUSTOMER' | 'SUPPLIER' | 'ALL' = 'ALL') {
  const bal = Number(party.current_balance || 0);
  if (viewMode === 'CUSTOMER' || (viewMode === 'ALL' && party.party_type === 'CUSTOMER')) {
    return {
      due: bal > 0 ? bal : 0,
      advance: bal < 0 ? Math.abs(bal) : 0,
    };
  }
  if (viewMode === 'SUPPLIER' || (viewMode === 'ALL' && party.party_type === 'SUPPLIER')) {
    return {
      due: bal < 0 ? Math.abs(bal) : 0,
      advance: bal > 0 ? bal : 0,
    };
  }
  return {
    due: bal < 0 ? Math.abs(bal) : bal,
    advance: 0,
  };
}
