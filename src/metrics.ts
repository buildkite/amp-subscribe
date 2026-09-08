type Labels = Record<string, string>

function labelKey(labels: Labels): string {
  return Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${value.replace(/([\\"])/g, "\\$1")}"`)
    .join(",")
}

function renderSeries(name: string, type: "counter" | "gauge", help: string, values: Map<string, number>): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`]
  for (const [key, value] of values) lines.push(key ? `${name}{${key}} ${value}` : `${name} ${value}`)
  return lines.join("\n")
}

export class Counter {
  private readonly values = new Map<string, number>()
  constructor(private readonly name: string, private readonly help: string) {}

  inc(labels: Labels = {}, value = 1): void {
    const key = labelKey(labels)
    this.values.set(key, (this.values.get(key) ?? 0) + value)
  }

  render(): string {
    return renderSeries(this.name, "counter", this.help, this.values)
  }
}

export class Gauge {
  private readonly values = new Map<string, number>()
  constructor(private readonly name: string, private readonly help: string) {}

  set(labels: Labels = {}, value: number): void {
    this.values.set(labelKey(labels), value)
  }

  render(): string {
    return renderSeries(this.name, "gauge", this.help, this.values)
  }
}

export class MetricsRegistry {
  private readonly metrics: Array<Counter | Gauge> = []

  counter(name: string, help: string): Counter {
    const counter = new Counter(name, help)
    this.metrics.push(counter)
    return counter
  }

  gauge(name: string, help: string): Gauge {
    const gauge = new Gauge(name, help)
    this.metrics.push(gauge)
    return gauge
  }

  render(): string {
    return `${this.metrics.map((metric) => metric.render()).join("\n")}\n`
  }
}
