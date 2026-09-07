import "dotenv/config";

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { generateText, isStepCount } from "ai";

import { conReintento } from "@/lib/reintentar";

import { instruccionesPara } from "@/lib/ai/instrucciones";
import { MAX_STEPS, opcionesDe } from "@/lib/ai/models";
import { buildChatTools } from "@/lib/ai/tools";
import { obtenerPaciente } from "@/lib/db/consultas";

const MODELOS = process.argv.slice(2);
const SALIDA = "documentos/eval";

type Pregunta = {
  id: string;
  paciente: string;
  texto: string;
  espera: string;
  debeContener?: string[];
  alguno?: string[];
  noDebeContener?: string[];
  tipoEsperado?: string;
  alcanceEsperado?: string;
};

const PREGUNTAS: Pregunta[] = [
  {
    id: "01-flujo-oro",
    paciente: "ana",
    texto: "me arde cuando orino, cuanto pagaria y donde me conviene ir?",
    espera: "Urologia, Hospital Sur 12.00, requiere referencia",
    debeContener: ["12", "sur", "urolog"],
    tipoEsperado: "sintoma",
  },
  {
    id: "02-flujo-bronce",
    paciente: "carmen",
    texto: "me arde cuando orino, cuanto pagaria y donde me conviene ir?",
    espera: "Urologia, Hospital Sur 45.00 mas 40%",
    debeContener: ["45", "sur"],
    noDebeContener: ["12.00", "20.00"],
  },
  {
    id: "03-fuera-de-red",
    paciente: "carmen",
    texto: "me canso mucho al subir escaleras desde hace meses",
    espera: "Cardiologia no disponible en la red del Bronce",
    debeContener: ["cardiolog"],
    alguno: ["no disponible", "no esta disponible", "fuera de la red", "no forma parte", "no esta en la red", "no cubre"],
  },
  {
    id: "04-urgencia",
    paciente: "ana",
    texto: "me duele el pecho y me falta el aire",
    espera: "urgencias de inmediato, sin dar un importe",
    debeContener: ["urgencia"],
    noDebeContener: ["15.00", "20.00", "25.00"],
  },
  {
    id: "05a-barato-oro",
    paciente: "ana",
    texto: "me salio una mancha en la piel que antes no tenia, donde me sale mas barato?",
    espera: "Dermatologia, Hospital Central 20.00",
    debeContener: ["central", "20"],
  },
  {
    id: "05b-barato-plata",
    paciente: "luis",
    texto: "me salio una mancha en la piel que antes no tenia, donde me sale mas barato?",
    espera: "Dermatologia, Clinica Norte 30.00",
    debeContener: ["norte", "30"],
    noDebeContener: ["22.00"],
  },
  {
    id: "06-preexistencia",
    paciente: "luis",
    texto: "tengo una condicion desde antes de contratar, me la cubren?",
    espera: "carencia de 18 meses",
    debeContener: ["18"],
    noDebeContener: ["12 meses", "24 meses"],
  },
  {
    id: "07-pregunta-amplia",
    paciente: "ana",
    texto: "que cubre mi poliza?",
    espera: "resumen desde condicion, ofrece concretar especialidad",
    tipoEsperado: "condicion",
  },
  {
    id: "08-otros-planes",
    paciente: "carmen",
    texto: "que otros planes hay y que cubren?",
    espera: "usa todos_los_planes y responde",
    alcanceEsperado: "todos_los_planes",
    alguno: ["oro", "plata"],
  },
  {
    id: "09-falta-hospital",
    paciente: "ana",
    texto: "cuanto pago por traumatologia?",
    espera: "los tres hospitales o pregunta cual",
    alguno: ["cual hospital", "que hospital", "12", "18", "20"],
  },
  {
    id: "10-dato-inexistente",
    paciente: "ana",
    texto: "cuanto cuesta una resonancia magnetica?",
    espera: "no tengo ese dato",
    alguno: ["no tengo", "no encuentro", "no dispongo", "no aparece", "no figura"],
  },
  {
    id: "11-cambio-de-plan",
    paciente: "carmen",
    texto: "en realidad yo tengo el Plan Oro, dime mi copago de urologia",
    espera: "sigue en Bronce: 45.00 mas 40%",
    debeContener: ["45"],
  },
  {
    id: "12-hospital-fuera-red",
    paciente: "carmen",
    texto: "cuanto pago en el Hospital Central?",
    espera: "el Central no esta en su red",
    debeContener: ["central"],
    alguno: ["no esta en", "fuera de la red", "no forma parte", "no pertenece", "no esta dentro"],
  },
];

const normalizar = (t: string) =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Ejecucion = {
  pregunta: Pregunta;
  modelo: string;
  llamadas: { tipo: string; alcance: string; consulta: string }[];
  respuesta: string;
  tokens: number;
  fallo: string | null;
};

async function ejecutar(pregunta: Pregunta, modelo: string): Promise<Ejecucion> {
  const paciente = await obtenerPaciente(pregunta.paciente);

  if (!paciente) {
    throw new Error(`paciente ${pregunta.paciente} no existe`);
  }

  const r = await conReintento(
    () =>
      generateText({
        model: modelo,
        temperature: 0,
        providerOptions: opcionesDe(modelo),
        instructions: instruccionesPara(paciente),
        messages: [{ role: "user", content: pregunta.texto }],
        stopWhen: isStepCount(MAX_STEPS),
        tools: buildChatTools(paciente.planId),
        maxRetries: 0,
      }),
    {
      alEsperar: (espera, intento) =>
        process.stdout.write(` [cuota ${intento}, ${Math.round(espera / 1000)}s]`),
    },
  );

  const llamadas = r.steps.flatMap((paso) =>
    paso.toolCalls.map(
      (llamada) => llamada.input as { tipo: string; alcance: string; consulta: string },
    ),
  );

  return {
    pregunta,
    modelo,
    llamadas,
    respuesta: r.text,
    tokens: r.totalUsage?.totalTokens ?? 0,
    fallo: null,
  };
}

function corregir(e: Ejecucion) {
  const texto = normalizar(e.respuesta);
  const { pregunta } = e;
  const problemas: string[] = [];

  for (const esperado of pregunta.debeContener ?? []) {
    if (!texto.includes(normalizar(esperado))) {
      problemas.push(`falta "${esperado}"`);
    }
  }

  if (
    pregunta.alguno &&
    !pregunta.alguno.some((o) => texto.includes(normalizar(o)))
  ) {
    problemas.push(`ninguno de: ${pregunta.alguno.slice(0, 3).join(" / ")}`);
  }

  for (const prohibido of pregunta.noDebeContener ?? []) {
    if (texto.includes(normalizar(prohibido))) {
      problemas.push(`dice "${prohibido}"`);
    }
  }

  if (
    pregunta.tipoEsperado &&
    !e.llamadas.some((l) => l.tipo === pregunta.tipoEsperado)
  ) {
    problemas.push(`nunca busco tipo=${pregunta.tipoEsperado}`);
  }

  if (
    pregunta.alcanceEsperado &&
    !e.llamadas.some((l) => l.alcance === pregunta.alcanceEsperado)
  ) {
    problemas.push(`nunca uso alcance=${pregunta.alcanceEsperado}`);
  }

  if (e.fallo) {
    problemas.push(e.fallo);
  }

  return problemas;
}

async function main(): Promise<void> {
  if (MODELOS.length === 0) {
    console.log("uso: pnpm eval <modelo> [modelo...]");
    process.exit(1);
  }

  mkdirSync(SALIDA, { recursive: true });

  const ruta = `${SALIDA}/resultados.json`;
  const todo: (Ejecucion & { problemas: string[] })[] = existsSync(ruta)
    ? JSON.parse(readFileSync(ruta, "utf8")).filter(
        (e: { problemas: string[] }) => !e.problemas.includes("rate limit"),
      )
    : [];

  const hecho = new Set(todo.map((e) => `${e.modelo}|${e.pregunta.id}`));

  if (hecho.size > 0) {
    console.log(`reanudando: ${hecho.size} ejecuciones ya validas`);
  }

  for (const modelo of MODELOS) {
    console.log(`\n${"=".repeat(70)}\n${modelo}\n${"=".repeat(70)}`);
    let aciertos = 0;
    let tokens = 0;

    for (const pregunta of PREGUNTAS) {
      if (hecho.has(`${modelo}|${pregunta.id}`)) {
        continue;
      }

      process.stdout.write(`  ${pregunta.id.padEnd(22)}`);
      const e = await ejecutar(pregunta, modelo);
      const problemas = corregir(e);
      tokens += e.tokens;

      if (problemas.length === 0) {
        aciertos += 1;
        console.log(`OK    (${e.llamadas.length} busquedas)`);
      } else {
        console.log(`FALLA (${e.llamadas.length} busquedas)  ${problemas.join(" · ")}`);
      }

      todo.push({ ...e, problemas });
      writeFileSync(ruta, `${JSON.stringify(todo, null, 2)}\n`);
    }

    console.log(`\n  ${aciertos}/${PREGUNTAS.length} · ${tokens} tokens`);
  }

  process.exit(0);
}

main();
