import { FacebookAffiliateStatus, FacebookSelectionRule } from "./facebook.enums";
import { selectAffiliateLinks } from "./facebook-affiliate.selector";
import { classifyFacebookFailure } from "./facebook-retry";

const now = new Date("2026-06-01T00:00:00.000Z");

function link(partial: Partial<Parameters<typeof selectAffiliateLinks>[0]["links"][number]> & { id: string }) {
  return {
    name: partial.id,
    affiliateUrl: `https://example.com/${partial.id}`,
    destinationUrl: null,
    productGroup: "general",
    keywords: [],
    pageIds: [],
    status: FacebookAffiliateStatus.ACTIVE,
    startsAt: null,
    endsAt: null,
    ...partial,
  };
}

describe("Facebook affiliate selection", () => {
  const links = [
    link({ id: "a", productGroup: "shoes", keywords: ["giày"] }),
    link({ id: "b", productGroup: "shoes" }),
    link({ id: "c", productGroup: "bags", pageIds: ["page-1"] }),
    link({ id: "paused", status: FacebookAffiliateStatus.PAUSED }),
    link({ id: "ended", endsAt: new Date("2026-01-01T00:00:00.000Z") }),
  ];

  it("keeps active in-range links that match the page and keywords", () => {
    const picked = selectAffiliateLinks({
      links,
      pageGraphId: "page-2",
      content: "Giày mới",
      count: 5,
      rule: FacebookSelectionRule.RANDOM,
      cursor: 0,
      now,
      random: () => 0,
    });
    expect(picked.picked.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("walks sequential links from the cursor", () => {
    const picked = selectAffiliateLinks({
      links: [link({ id: "a" }), link({ id: "b" }), link({ id: "c" })],
      pageGraphId: "page-1",
      content: "",
      count: 2,
      rule: FacebookSelectionRule.SEQUENTIAL,
      cursor: 1,
      now,
    });
    expect(picked.picked.map((item) => item.id)).toEqual(["b", "c"]);
    expect(picked.nextCursor).toBe(3);
  });

  it("takes one link from each product group", () => {
    const picked = selectAffiliateLinks({
      links,
      pageGraphId: "page-1",
      content: "không khớp từ khóa giày nên chỉ còn link không từ khóa",
      count: 2,
      rule: FacebookSelectionRule.GROUP,
      cursor: 0,
      now,
    });
    expect(picked.picked.map((item) => item.productGroup).sort()).toEqual(["bags", "shoes"]);
  });
});

describe("Facebook failure classification", () => {
  it("retries an explicit rate-limit response", () => {
    expect(classifyFacebookFailure({ hasResponse: true, httpStatus: 400, graphCode: 613 })).toMatchObject({
      retryable: true,
      uncertain: false,
    });
  });

  it("does not retry when the response never arrived", () => {
    expect(classifyFacebookFailure({ hasResponse: false })).toMatchObject({ retryable: false, uncertain: true });
  });

  it("treats token errors as permission loss", () => {
    expect(classifyFacebookFailure({ hasResponse: true, graphCode: 190 })).toMatchObject({ permission: true, retryable: false });
  });
});
