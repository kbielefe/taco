import { describe, expect, it } from "vitest";
import { titleCase } from "./title.js";

describe("titleCase", () => {
  it("capitalizes major words like a book title", () => {
    expect(titleCase("fried rice")).toBe("Fried Rice");
    expect(titleCase("cheerios and milk")).toBe("Cheerios and Milk");
    expect(titleCase("body weight")).toBe("Body Weight");
    expect(titleCase("a day in the life")).toBe("A Day in the Life");
  });

  it("keeps small words capitalized at the ends", () => {
    expect(titleCase("of rice and")).toBe("Of Rice And");
  });

  it("capitalizes hyphenated parts", () => {
    expect(titleCase("sugar-free yogurt")).toBe("Sugar-Free Yogurt");
  });

  it("leaves blank and whitespace-only strings alone", () => {
    expect(titleCase("")).toBe("");
    expect(titleCase("   ")).toBe("   ");
  });
});
