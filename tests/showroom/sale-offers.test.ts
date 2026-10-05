import { describe, expect, it } from "vitest";
import { coveringOffer, salePercent } from "../../src/showroom/ui";
import { TIP_PACKS, marksForTipCredits } from "../../src/economy/tips";
import type { EarnOffer } from "../../src/economy/types";

const offer = (marks: number, worth: number, extra: Partial<EarnOffer> = {}): EarnOffer =>
  ({ id: `o${marks}`, sourceId: "tips", title: "", blurb: "", marks, cta: "", worth, ...extra }) as EarnOffer;

describe("sale packs", () => {
  it("derives the save percentage from the base rate", () => {
    expect(salePercent(offer(8050, 5000))).toBe(38);
    expect(salePercent(offer(18050, 10000))).toBe(45);
    expect(salePercent(offer(50050, 25000))).toBe(50);
    expect(salePercent(offer(200, 200))).toBe(0);
    expect(salePercent({ marks: 100, worth: undefined })).toBe(0);
  });
  it("matches the badges on the sale tip packs", () => {
    for (const pack of TIP_PACKS.filter(entry => entry.sale)) {
      const marks = offerMarks(pack.credits);
      expect(pack.badge).toContain(`save ${salePercent({ marks, worth: pack.credits })}%`);
    }
  });
  it("covers a shortfall with the smallest pack that is enough", () => {
    const offers = [offer(200, 200), offer(390, 350), offer(8050, 5000, { sale: true }), offer(50050, 25000, { sale: true })];
    expect(coveringOffer(offers, 300)?.marks).toBe(390);
    expect(coveringOffer(offers, 5000)?.marks).toBe(8050);
    expect(coveringOffer(offers, 0)).toBeNull();
  });
});

function offerMarks(credits: number): number {
  return marksForTipCredits(credits);
}
