import { describe, expect, it } from 'vitest';
import { centsToAmount, moneyToCents, sillLineCents, tileAreaThousandths, tileLineCents, unitCents } from '../src/pricing';

describe('unitCents', () => {
  it('multiplies legacy ERP prices by 100', () => {
    expect(unitCents(85)).toBe(8500);
    expect(unitCents(999)).toBe(99_900);
  });

  it('keeps full-cent prices as they are', () => {
    expect(unitCents(1000)).toBe(1000);
    expect(unitCents(8547)).toBe(8547);
  });
});

describe('sillLineCents', () => {
  it('prices a vensterbank by area: 40 x 200 cm at 85 cent legacy', () => {
    const cents = sillLineCents('sill_m2', 85, 40, 200);
    expect(cents).toBe(6800);
    expect(centsToAmount(cents)).toBe('68.00');
  });

  it('prices a raamdorpel by length: 150 cm at 8547 cent', () => {
    const cents = sillLineCents('sill_m1', 8547, undefined, 150);
    expect(cents).toBe(12_821);
    expect(centsToAmount(cents)).toBe('128.21');
  });

  it('ignores depth for a raamdorpel', () => {
    expect(sillLineCents('sill_m1', 8547, 20, 150)).toBe(12_821);
  });
});

describe('moneyToCents', () => {
  it('reads Admin API decimal prices', () => {
    expect(moneyToCents('0.85')).toBe(85);
    expect(moneyToCents('85.47')).toBe(8547);
    expect(moneyToCents('12.0')).toBe(1200);
    expect(moneyToCents('0.29')).toBe(29);
  });
});

describe('tileLineCents', () => {
  it('prices 35 boxes of 1,44 m² at 47,01 per m² as 50,4 m², rounded once', () => {
    expect(tileAreaThousandths(35, 1.44)).toBe(50_400);
    expect(tileLineCents(4701, 35, 1.44)).toBe(236_930);
  });

  it('keeps float noise out of the area: 3 boxes of 1,418 m²', () => {
    expect(tileAreaThousandths(3, 1.418)).toBe(4254);
    expect(tileLineCents(3995, 3, 1.418)).toBe(16_995);
  });

  it('does not apply the legacy ÷100 switch to tiles', () => {
    expect(tileLineCents(995, 10, 1)).toBe(9950);
  });
});
