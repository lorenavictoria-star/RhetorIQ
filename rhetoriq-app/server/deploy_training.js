const { Pool } = require('pg');
const pool = new Pool({
  connectionString: 'postgresql://rhetoriq_db_user:qXv6yidawqN18C7HuE7pb7ajhygnkJHQ@dpg-d91rg19kh4rs73arevpg-a.oregon-postgres.render.com/rhetoriq_db',
  ssl: { rejectUnauthorized: false }
});

async function insert(advisorId, clientId, examples) {
  for (const ex of examples) {
    if (ex.type === 'brand_voice') {
      await pool.query(
        `INSERT INTO company_memory (advisor_id, client_id, category, content)
         VALUES ($1,$2,'brand_voice',$3) ON CONFLICT DO NOTHING`,
        [advisorId, clientId, ex.content]
      );
      console.log('  BV saved:', ex.label);
    } else {
      const r = await pool.query(
        `INSERT INTO module_examples
           (advisor_id, module_key, label, industry_tag, input_text, output_text,
            rating, source_client_id, is_cross_client_shareable, auto_generated)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false) RETURNING id`,
        [advisorId, ex.module, ex.label, ex.tag, ex.input, ex.output,
         ex.rating ?? 5, clientId ?? null, ex.shareable ?? true]
      );
      console.log(`  ✓ #${r.rows[0].id} [${ex.module}] ${ex.label}`);
    }
  }
}

async function main() {
  const { rows: [adv] } = await pool.query(
    `SELECT id FROM users WHERE role IN ('advisor','admin') ORDER BY id LIMIT 1`);
  const advisorId = adv.id;

  const clientId = async (search) => {
    const { rows } = await pool.query(
      `SELECT id FROM clients WHERE name ILIKE $1 LIMIT 1`, [`%${search}%`]);
    return rows[0]?.id ?? null;
  };

  // ── HOF WEISSBAD ──────────────────────────────────────────────
  console.log('\n── Hof Weissbad ──');
  await insert(advisorId, null, [
    {
      module: 'before-after', rating: 5, shareable: true,
      label: 'Webseitentext Resort-Einleitung – Feinschliff Tonalität',
      tag: 'Hotellerie / Tourismus',
      input: `VORHER:\nAnkommen, abschalten, geniessen – im schönen Appenzellerland erwartet Sie das Resort Hof Weissbad. Ein Ort der Ruhe und Erholung mit Wellness, exzellenter Küche und herzlicher Gastfreundschaft – das ganze Jahr über. Zwei Häuser, ein Gefühl: Erholung oder Aktivitäten – Sie haben die Wahl.\n\nWas soll besser werden: Der Text soll dem Auge mehr Luft lassen. Die drei Schlagwörter «Ankommen, abschalten, geniessen» sollen als eigenständige Zeile wirken. Der Übergang zu den zwei Häusern soll klarer werden. Tonalität: warm, einladend, mit Appenzeller Charakter – kein generisches Hotelmarketing.`,
      output: `Chönd zonis!\nAnkommen, abschalten, geniessen.\n\nIm schönen Appenzellerland erwartet Sie das Resort Hof Weissbad.\n\nZwei Häuser, ein Gefühl: Erholung oder Aktivitäten – Sie haben die Wahl. Im Vier-Sterne-Superior-Hotel Hof Weissbad finden Sie kulinarische Genüsse und tanken neue Energie. Die moderne Weissbad Lodge bietet eine entspannte Atmosphäre und aktive Erlebnisse im Appenzellerland.\n\nImmer inklusive: liebevolle Details, erstklassiger Komfort und ein Rundum-sorglos-Paket.\n\nIhr Lieblingsort – pure Freude.`
    },
    {
      module: 'before-after', rating: 5, shareable: true,
      label: 'Webseitentext Klinik – sachliche Qualitätsaussage schärfen',
      tag: 'Hotellerie / Gesundheit',
      input: `VORHER:\nUnsere Klinik bietet modernste medizinische Betreuung. Wir haben eine hohe Patientenzufriedenheit und ein erfahrenes Ärzteteam. Komplementärmedizin ergänzt unser Angebot.\n\nWas soll besser werden: Weniger Aufzählung, mehr Haltung. Die Aussage «beste Rehabilitationsklinik der Schweiz» soll klar und selbstbewusst stehen. Komplementärmedizin soll als ganzheitlicher Ansatz positioniert werden, nicht als Add-on.`,
      output: `Dank unserer herausragenden Patientenzufriedenheit zählen wir zu den besten Rehabilitationskliniken der Schweiz. Ein erfahrenes Ärzteteam und eine moderne Infrastruktur schaffen optimale Bedingungen für eine gute Genesung. Zudem ergänzt unser Angebot an Komplementärmedizin die medizinische Betreuung auf ganzheitliche Weise.`
    },
    {
      module: 'text-gen', rating: 5, shareable: true,
      label: 'Webseitentext 4-Sterne-Resort – Teaser Startseite',
      tag: 'Hotellerie / Tourismus',
      input: `Schreibe einen Teaser-Text für die Startseite eines 4-Sterne-Superior-Resorts im Appenzellerland. Das Resort heisst Hof Weissbad und besteht seit 30 Jahren. Es hat 89 Zimmer, eigenen Kräutergarten mit 90 Heilkräutern, Spa und mehrere Restaurants. 255 Mitarbeitende. Tonalität: warm, regional verankert, mit Appenzeller Charakter – kein generisches Hotelmarketing. Text soll Nähe und Qualität gleichzeitig vermitteln.`,
      output: `Ein Ort, der immer bleibt.\n\nSeit 30 Jahren steht das Hotel Hof Weissbad für echte Auszeiten im Herzen des Appenzellerlandes. 89 stilvolle Zimmer, eine einladende Terrasse mit Blick auf den Alpstein, ein eigener Kräutergarten mit 90 Heilkräutern und der «Wissbach» direkt vor der Tür.\n\nIm Spa, in unseren Restaurants oder bei Veranstaltungen und Seminaren – höchste Qualität und herzliche Gastfreundschaft, verbunden mit Appenzeller Tradition. Das sind wir: 255 Mitarbeitende, die immer für Sie da sind.`
    },
    {
      module: 'text-gen', rating: 5, shareable: true,
      label: 'Gastronomie-Teaser – Küchenchefin mit Persönlichkeit positionieren',
      tag: 'Hotellerie / Gastronomie',
      input: `Schreibe einen kurzen Teaser-Text für die Kulinarik-Seite eines Gourmet-Restaurants im Hotel. Die Küchenchefin heisst Käthi Fässler, ist seit über 20 Jahren im Haus und hat 16 Gault-Millau-Punkte. Es gibt vier Restaurantbereiche: Restaurant Flickflauder, Veranda, Schotten-Sepp-Stube und Bistro mit Bar. Tonalität: persönlich, mit Stolz aber ohne Arroganz, Tradition und Innovation verbinden.`,
      output: `Gaumenfreuden, die bleiben.\n\nSeit über 20 Jahren bringt Küchenchefin Käthi Fässler zusammen mit ihrem Team kreative Meisterwerke auf den Teller – 16 Gault-Millau-Punkte sprechen für sich.\n\nKulinarische Vielfalt im Restaurant «Flickflauder», in der Veranda, in der rustikalen Schotten-Sepp-Stube oder im geselligen Bistro mit Bar.`
    },
    {
      module: 'text-gen', rating: 5, shareable: true,
      label: 'Spa & Wellness – atmosphärischer Text mit Naturverbindung',
      tag: 'Hotellerie / Wellness',
      input: `Schreibe einen Einleitungstext für die Spa- und Wellness-Seite eines Resorts in den Appenzeller Alpen. Das Bade- und Saunahaus ist aus duftendem Fichtenholz und Glas. Es gibt Quellwasser, Naturschwimmbad, 36-Grad-Becken, Saunen und Dampfbad. Tonalität: sinnlich, ruhig, mit Naturbezug – der Gast soll das Loslassen spüren können.`,
      output: `Alpiner Kristall.\n\nWillkommen im modernen Bade- und Saunahaus: ein Gebäude aus duftendem Fichtenholz, umhüllt von Glas.\n\nGeniessen Sie erfrischendes Quellwasser, das Naturschwimmbad, ein 36 Grad beheiztes Becken, verschiedene Saunen und das Dampfbad – alles, was Sie brauchen, um den Kopf freizubekommen und Ihren Körper zu beleben.\n\nHier trifft moderne Wellness auf Natur pur. Der Wechsel von Wärme und Kälte belebt, Bewegung gibt Kraft, das Wasser schenkt Leichtigkeit. Auf der Liege ist es Zeit, loszulassen, anzukommen und zu verweilen.`
    }
  ]);

  // ── JOANNE ────────────────────────────────────────────────────
  console.log('\n── Joanne Sieber (CEO Deep Tech Nation) ──');
  const joanneId = await clientId('joanne');
  await insert(advisorId, joanneId, [
    {
      type: 'brand_voice', label: 'Brand Voice Joanne Sieber',
      content: `JOANNE SIEBER — CEO Deep Tech Nation Switzerland\n\nSPRACHE: Bilingual (EN / DE), je nach Anlass\n\nENGLISCH — Rede & Auftritte:\n- Sehr kurze Sätze. Dramatische Pausen. [pause]-Markierungen im Skript.\n- Emotionales Storytelling: persönliche Anekdoten, konkrete Momente\n- Wiederkehrender Anker: Roger Federer Quote — "In Switzerland, we don't dream this big. We hope to be good — but not great."\n- Struktur: Warm Welcome → Kernaussage → Dankbarkeit → Aufruf\n- Tonalität: warm, echt, kein Corporate-Sprech, sichtbare Überzeugung\n\nDEUTSCH — Keynote & Selbstpräsentation:\n- Direkt, mutig, zahlenstark: "85% des Wachstumskapitals kommt aus dem Ausland"\n- Starke Metaphern: "Eisenbahn des 21. Jahrhunderts", "Ich baue nicht die Autos, ich asphaltiere die Strasse"\n- Klares Selbstbild: "Ich bin keine Fondsmanagerin. Ich bin Katalysator."\n- Zukunftsvision konkret: "5 Mrd. Franken VC bis 2033", "100'000 neue Arbeitsplätze"\n\nBEIDE SPRACHEN:\n- Authentisch vor eloquent — echte Überzeugung, kein Verkauf\n- Persönliche Momente zeigen (Teamdank, Emotionen zulassen)\n- Mission immer im Subtext: CH erfindet → CH muss auch skalieren und besitzen`
    },
    {
      module: 'text-gen', rating: 5, shareable: false,
      label: 'CEO Welcome Speech – VIP Event, English, pause-scripted',
      tag: 'Non-Profit / Deep Tech / Public Affairs',
      input: `Write a welcome speech (5–7 min) for Joanne Sieber, CEO of Deep Tech Nation Switzerland, at a VIP evening event at the University of Zurich with entrepreneurs, researchers, investors and policymakers.\n\nContext:\n- Deep Tech Nation Switzerland mobilizes CHF 50bn in VC, creates 100,000 jobs, positions Switzerland as global deep tech leader\n- Audience: ~80 invited VIPs, mix of long-time supporters and new faces\n- Tone: warm, personal, emotionally anchored — NOT a corporate pitch\n- Language: English\n- Format: short sentences, mark pauses with [pause], include at least one personal moment about a supporter/team member\n\nKey message: Switzerland has world-class science but settles for "good" — DTN exists to make it reach for "great."\nUse the Roger Federer quote as the opening anchor: "In Switzerland, we don't dream this big. We hope to be good — but not great."`,
      output: `Good evening.\n[pause]\n\nIt is… such a joy — and a privilege — to welcome you tonight.\n[pause]\n\nI look around… and I see familiar faces who've been with us since the very first conversation. And I see new faces — who, I hope, by the end of this evening — will feel part of something bigger than themselves.\n[pause]\n\nTwo years ago, Trevor Noah asked Roger Federer if he knew he would one day become one of the greatest tennis players in the world. Roger laughed and said: "No, no, I did not know it was going to turn out this good. In Switzerland, we don't dream this big. We hope to be good — but not great."\n[longer pause]\n\nThat struck me. Because it's not just about tennis. It's about us.\n[pause]\n\nWe have world-class science. World-class entrepreneurs. World-class innovation. Yet too often… we settle for "good enough" when the world needs us to reach for great.\n[pause]\n\nThat is why Deep Tech Nation exists — to unite science, entrepreneurship, capital, and policy… so Switzerland doesn't just keep up — but leads.\n[pause]\n\nMany of you have given us your time… your networks… your trust. You've listened to our ideas — challenged them — sharpened them. You've opened doors we could never have opened alone.\n[pause]\n\nAnd there have been moments that have left me… almost speechless. Like the day someone in this very room… cut short their holiday — yes, their holiday — to join a roundtable with Swiss pension funds. No reward. No spotlight. Just the belief that being there… mattered.\n[pause]\n\nThat is commitment. That is what makes this possible.\n[pause]\n\nSo tonight — to our Board of Trustees… our Advisory Board… to every supporter in this room — thank you. From the bottom of my heart.\n[pause]\n\nAnd to my extraordinary team — your resilience, your relentless drive, your ability to push when the days are long and the stakes are high… I could not be prouder.\n[pause]\n\nThe truth is… we're just getting started. So let's keep going. Let's make Switzerland… not just a participant — but a leader — in the deep tech revolution.\n[pause]\n\nThank you.`
    },
    {
      module: 'text-gen', rating: 5, shareable: false,
      label: 'CEO Selbstpräsentation – Keynote-Einstieg Deutsch, Metaphern-driven',
      tag: 'Non-Profit / Deep Tech / Public Affairs',
      input: `Schreibe einen CEO-Einstieg (3–4 Min) für Joanne Sieber, CEO Deep Tech Nation Switzerland, auf Deutsch für ein Publikum von Investoren, Unternehmern und Politikern.\n\nKontext:\n- DTN mobilisiert Schweizer Kapital (Pensionskassen, Family Offices) für Deep Tech\n- Problem: 85% des VC kommt aus dem Ausland, Schweizer Investoren bei 4%\n- DTN ist kein Fonds — sie ist Katalysator, arbeitet am System\n- Ziel: VC in CH bis 2033 verdoppeln auf 5 Mrd. CHF, 100'000 Arbeitsplätze\n\nTonalität: direkt, persönlich, mit Überzeugung — kein NGO-Sprech, kein PowerPoint-Vortrag. Mindestens eine starke Metapher. Abschluss mit Zukunftsbild.`,
      output: `[Wissen Sie, ich werde oft gefragt, warum ich diesen Job als CEO bei DTN mache. Die Antwort ist eigentlich simpel.]\n\nDie Schweiz ist Weltmeister im Erfinden – aber nicht im Skalieren. Wir haben exzellente Forschung und mutige Talente. Aber der Wohlstand für die nächste Generation, der entsteht nicht im Labor. Sondern im Markt. Und genau dort verlieren wir heute den Anschluss.\n\nSchauen Sie sich die Zahlen an: Über 85% des Wachstumskapitals für Schweizer Deep-Tech-Firmen kommt aus dem Ausland. Schweizer Investoren sind mit 4% praktisch unsichtbar.\n\nUnd ich rede hier nicht von der nächsten Lifestyle-App für Pizza-Lieferungen. Ich spreche von Deep Tech. Das ist die «Eisenbahn des 21. Jahrhunderts». Es geht um Lösungen gegen den Klimawandel, um Krebsforschung, um Energiesicherheit. Wenn wir diese Technologien erfinden, aber am Ende nicht besitzen, verlieren wir nicht nur die Gewinne. Wir verlieren unsere technologische Souveränität.\n\nGenau deshalb mache ich diesen Job. Unsere Mission bei Deep Tech Nation ist es, dass dieser Funke überspringt – dass Schweizer Kapital und Schweizer Innovation endlich zusammenfinden.\n\nIch bin keine Fondsmanagerin. Wir arbeiten am System, nicht im System. Ich sehe mich als Katalysator. Bildlich gesagt: Ich baue nicht die Autos. Ich sorge dafür, dass die Strasse asphaltiert ist, damit unser Kapital überhaupt fliessen kann.\n\nUnser Ziel ist ambitioniert, aber machbar: Wir wollen das investierte Venture Capital bis 2033 verdoppeln – auf 5 Milliarden Franken. Das ist der Treibstoff für 100'000 neue Arbeitsplätze und um unsere Wirtschaft für die nächsten 50 Jahre zu sichern.\n\nIch möchte in 10 Jahren nicht mehr über «vielversprechende Startups» reden. Ich möchte, dass wir auf die neuen Nestlés und Roches anstossen können – die hier gross geworden sind und uns gehören. Swiss made.`
    },
    {
      module: 'text-gen', rating: 5, shareable: true,
      label: 'Coaching-Leitfaden: Auftrittssicherheit & kritische Fragen',
      tag: 'Kommunikation / Coaching',
      input: `Erstelle einen Coaching-Leitfaden für eine Führungsperson, die wichtige öffentliche Auftritte (Keynotes, Podiumsdiskussionen, VIP-Events) vorbereitet. Fokus: Aussetzer verhindern, Authentizität bewahren, kritische Fragen souverän meistern. Praxisnah, ohne Floskeln.`,
      output: `Instrumente für sichere, authentische und selbstbewusste Auftritte\n\nVOR DEM AUFTRITT\nGründliche Vorbereitung: Inhalt ganz kennen, mehrfach laut üben – idealerweise vor Publikum oder auf Aufnahme.\nPositive Körpersprache einüben: aufrechte Haltung, offener Blickkontakt, gezielte Gestik.\nKernbotschaften verankern: 3 Hauptaussagen, die du auswendig kennst – dein Sicherheitsnetz wenn du ins Stocken gerätst.\n\nWÄHREND DES AUFTRITTS\nKontrollierte Atmung: bewusst tief und ruhig – reduziert Stress, hält Stimme klar.\nFokus auf Botschaft, nicht auf dich: echte Neugier am Publikum schlägt Selbstbeobachtung.\nFehler souverän behandeln: kurzes Lächeln, Überleitung – wirkt menschlich, nicht schwach.\nStimme modulieren: Tempo, Lautstärke, Tonhöhe variieren – Monotonie verliert das Publikum.\n\nUMGANG MIT KRITISCHEN FRAGEN\nZuhören und paraphrasieren: "Wenn ich Sie richtig verstehe, geht es Ihnen um…" – gibt Zeit und zeigt Respekt.\nStrategisch pausieren: ein bewusster Atemzug vor der Antwort signalisiert Souveränität.\nReframing: negative Fragen in positive Richtung lenken.\nBridging: von schwierigen Themen zu Kernbotschaften überleiten.\nWissenslücken offen zugeben: "Das kann ich Ihnen gerne nachreichen" erhöht Glaubwürdigkeit.`
    }
  ]);

  // ── STEFAN ────────────────────────────────────────────────────
  console.log('\n── Stefan (Schulrektor) ──');
  const stefanId = await clientId('stefan');
  await insert(advisorId, stefanId, [
    {
      type: 'brand_voice', label: 'Brand Voice Stefan',
      content: `STEFAN — Schulrektor, Volksschule Eschenbach SG\n\nROLLE: Rektor (seit 2025), spricht an Eltern, Lehrpersonen, Behörden, Schüler\n\nFÜHRUNGSSPRACHE:\n- Kernphilosophie: «Führung als Einladung zur Mitgestaltung»\n- Persönlicher Leitsatz: «Du machst einen guten Job, wenn deine Lehrpersonen ihren gut machen können.»\n- Betont immer: Klarheit, Fairness, Transparenz — ohne Kontrolle zu wirken\n- Unterscheidet klar zwischen «Struktur schaffen» und «Kontrolle ausüben»\n\nSPRACHSTIL:\n- Kurze, klare Sätze — kein Behördendeutsch, kein Fachjargon\n- Übergänge: warm und inhaltlich verknüpft, nie abrupt\n- Regelmässige persönliche Einschübe («Mir ist wichtig…», «Ich durfte erleben…»)\n- Lob ist konkret und persönlich — keine Floskeln\n\nKERNBOTSCHAFTEN:\n- «Nicht Kontrolle, sondern Orientierung geben»\n- «Verantwortung dort, wo das Wissen ist»\n- «Bevor wir entwickeln, müssen wir verstehen»\n- «Engagement sichtbar machen — das ist die höchste Form der Wertschätzung»`
    },
    {
      module: 'text-gen', rating: 5, shareable: true,
      label: 'Schulkonvent Begrüssung – Rektor, partizipativer Führungsstil',
      tag: 'Bildung / Schulführung',
      input: `Schreibe eine Begrüssung (5 Min.) für einen Schulrektor, der seinen ersten Schulkonvent leitet. Publikum: Lehrpersonen, Schulleitungen, Gemeinderat, externe Partner.\n\nKontext: Rektor seit 7 Monaten, empfindet Rolle als herausfordernd und erfüllend. Schulkonvent soll keine klassische Informationsveranstaltung sein, sondern Plattform für Transparenz, Orientierung und gemeinsames Verständnis. Führungsverständnis: Führung als Einladung zur Mitgestaltung.\n\nTonalität: warm, persönlich, einladend — nicht oberlehrerhaft. Klare Haltung ohne Distanz. Kleine persönliche Einblicke der letzten Monate einbauen.`,
      output: `Geschätzte Kolleginnen und Kollegen, liebe Mitarbeitende, sehr geehrte Damen und Herren\n\n«Schule ist mehr als Unterricht. Schule ist Gemeinschaft, Begegnung und Zusammenarbeit. Und genau das spürt man heute Abend, wenn wir gemeinsam diesen ersten Schulkonvent gestalten.»\n\nIch freue mich, dass wir hier zusammen sind – zum Austausch, zum Inspirierenlassen und zum Miteinander.\n\nDer Schulkonvent soll kein klassischer Informationstag sein. Er ist eine Plattform für Transparenz, Orientierung und ein gemeinsames Verständnis unserer Arbeit.\n\nSeit gut sieben Monaten bin ich als Rektor tätig – und ich empfinde diese Rolle tatsächlich als Einsatz: herausfordernd, aber auch sehr erfüllend. Ich durfte in dieser Zeit viel erleben, beobachten, gestalten – und vor allem: viele engagierte Menschen kennenlernen, die mit Herzblut für unsere Schule arbeiten. Das ist nicht selbstverständlich – und das schätze ich sehr.\n\nMein Führungsverständnis ist klar: Führung als Einladung zur Mitgestaltung. Es geht um Partizipation, Transparenz und Dialog – mit euch, mit den Schulleitungen, mit den Behörden und mit unseren Schülerinnen und Schülern.\n\nIch lade Sie ein, diesen Abend als Raum des Austauschs zu nutzen. Wir werden nicht nur Projekte und Prozesse besprechen – wir geben auch Einblick in unsere Haltungen und denken gemeinsam weiter.\n\nDenn: Wie wir arbeiten, ist mindestens so wichtig wie was wir tun.\n\nWillkommen zum Schulkonvent – wir legen los!`
    },
    {
      module: 'text-gen', rating: 5, shareable: true,
      label: 'Heikles Thema Lehrpersonen – Ämtli/Berufsauftrag transparent kommunizieren',
      tag: 'Bildung / Schulführung / Interne Kommunikation',
      input: `Ein Schulrektor muss Lehrpersonen über eine Neuregelung informieren: bisherige Zusatzentschädigungen für Ämtli fallen weg, weil diese Aufgaben künftig als Teil des kantonalen Berufsauftrags gelten.\n\nDas Thema ist heikel — es offenbart Ungleichheiten zwischen Standorten und wirkt als ob Engagement «abgewertet» wird.\n\nZiel: sachlich erklären warum die Änderung nötig ist, Fairness betonen, Engagement explizit würdigen — ohne zu beschwichtigen. Tonalität: klar, ehrlich, respektvoll. Kein Managementsprech. Konkrete nächste Schritte nennen.`,
      output: `Was wir täglich leisten, geht weit über Unterricht hinaus: Projekte, Teams, Ämtli. Der Berufsauftrag macht dies sichtbar.\n\nIn der Praxis wurden Ämtli unterschiedlich gehandhabt. Das führte verständlicherweise zu Fragen: Warum bekomme ich für ein Ämtli nichts, das an einem anderen Standort entschädigt wird? Wer entscheidet, was zum Berufsauftrag gehört?\n\nUnser Ziel ist klar: Klarheit und Fairness für alle Standorte.\n\nWas wir jetzt tun:\nDie Schulleitungen erfassen alle Ämtli. Im Schulleitungskonvent wird geklärt, was verbindlich zum Berufsauftrag gehört. Auf dieser Basis wird das Thema in die nächste Pensenplanung integriert.\n\nMir ist wichtig zu betonen: Damit wird das Engagement nicht klein gemacht. Im Gegenteil — wir verankern es fest im sichtbaren, zentralen Berufsauftrag. Das ist die höchste Form der Wertschätzung für euren Einsatz.\n\nDrei Punkte sind entscheidend:\nKlarheit: Alle sollen wissen, was selbstverständlich zum Beruf gehört.\nFairness: Gleiches wird gleich behandelt — unabhängig vom Standort.\nVerlässliche Führung: Entscheidungen sollen nachvollziehbar und transparent sein.\n\nIhr sollt wissen: Das Thema liegt auf Führungsebene in guten Händen. Wir nehmen euch mit, bevor es für euch konkret zu Änderungen kommt.`
    },
    {
      module: 'text-gen', rating: 5, shareable: true,
      label: 'Moderationsüberleitung – von komplexem Sachthema zu festlichem Highlight',
      tag: 'Bildung / Events / Moderation',
      input: `Schreibe eine kurze Überleitung (1 Min.) für einen Moderator, der gerade komplexe Organisationsthemen (Organigramm, Berufsauftrag, Reglemente) präsentiert hat und nun zu einem erfreulichen Highlight überleitet — Schüler präsentieren ihre Robotik-Erfolge.\n\nTon: die Spannung des schweren Themas lösen ohne es wegzuwischen, dann Vorfreude aufbauen.`,
      output: `Das war jetzt ein kompakter – vielleicht auch fordernder – Teil des Abends.\n\nEs ging um Strukturen, Zuständigkeiten, Prozesse. Themen, die auf den ersten Blick eher technisch erscheinen – aber in Wahrheit unser tägliches Miteinander prägen.\n\nMir war wichtig, euch zu zeigen: Verantwortung dort einsetzen, wo sie wirksam wird. Klarheit schaffen, damit Energie frei wird für das, was zählt: gute Schule.\n\nUnd damit das alles nicht zu trocken bleibt – wechseln wir jetzt die Perspektive.\n\nIch freue mich sehr, euch nun ein Highlight des heutigen Abends anzukündigen – und gleichzeitig eine ganz besondere Leistung zu würdigen.\n\nJetzt wird es spannend.`
    }
  ]);

  await pool.end();
  console.log('\n✓ Alle Trainingsbeispiele deployed.');
}

main().catch(e => { console.error(e.message); process.exit(1); });
