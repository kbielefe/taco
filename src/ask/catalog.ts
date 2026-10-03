import { formatPrompt } from "../mlflow/format.js";

export const CATALOG_ID = "https://health.bielefeldt.dev/a2ui/taco/v1/catalog.json";

export const MAX_SERIES = 4;
export const MAX_POINTS = 60;
export const MAX_COMPONENTS = 8;

export const CATALOG_INSTRUCTIONS_TEMPLATE = `Show a chart with A2UI v0.9 messages for catalog {{catalogId}}.
Send createSurface, then updateComponents. One surface per answer. The root component id is root.
Components are Column, Text, LineChart, and BarChart.
Column has children, an array of component ids.
Text has text and variant "title" or "body". Use plain text, not HTML.
LineChart and BarChart have title, unit, and series. Use LineChart for a change over time and BarChart for separate categories.
A series has name and points. A point has label and value. Use at most {{maxSeries}} series and {{maxPoints}} points in each series.
Name macro series Protein, Fat, Carbohydrate, and Fiber.
Call show for any series, comparison, or change over time, even when the user did not ask for a chart.
The chart is the answer. Add a Text body only for one short sentence the chart cannot show, and do not repeat its numbers.
Skip show only for a single fact, a yes or no, or a non-numeric list, and then use one short sentence.`;

export const CATALOG_INSTRUCTIONS = formatPrompt(CATALOG_INSTRUCTIONS_TEMPLATE, {
  catalogId: CATALOG_ID,
  maxSeries: String(MAX_SERIES),
  maxPoints: String(MAX_POINTS),
});

const chartComponent = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "Short chart title." },
    unit: { type: "string", description: "Unit for the values, such as kcal, g, or lb. Use an empty string when there is no unit." },
    series: {
      type: "array",
      maxItems: MAX_SERIES,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          points: {
            type: "array",
            maxItems: MAX_POINTS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                label: { type: "string", description: "Category or date label, such as Oct 3." },
                value: { type: "number" },
              },
              required: ["label", "value"],
            },
          },
        },
        required: ["name", "points"],
      },
    },
  },
  required: ["title", "unit", "series"],
};

export const CATALOG = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: CATALOG_ID,
  catalogId: CATALOG_ID,
  title: "Taco charts",
  protocolVersion: "0.9",
  instructions: CATALOG_INSTRUCTIONS,
  components: {
    Column: {
      type: "object",
      additionalProperties: false,
      description: "A vertical stack of other components.",
      properties: {
        children: {
          type: "array",
          description: "Component ids, top to bottom.",
          items: { type: "string" },
        },
      },
      required: ["children"],
    },
    Text: {
      type: "object",
      additionalProperties: false,
      description: "A plain sentence or title. No HTML.",
      properties: {
        text: { type: "string" },
        variant: { type: "string", enum: ["title", "body"] },
      },
      required: ["text", "variant"],
    },
    LineChart: {
      ...chartComponent,
      description: "A line chart for a measurement over time, such as weight or daily calories.",
    },
    BarChart: {
      ...chartComponent,
      description: "A bar chart for categories, such as Protein, Fat, Carbohydrate, and Fiber.",
    },
  },
};
