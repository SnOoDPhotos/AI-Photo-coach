import fs from 'fs';
import path from 'path';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let { provider, parts, systemPrompt, maxTokens } = req.body;
    if (!parts || !systemPrompt) return res.status(400).json({ error: 'Ontbrekende velden' });

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'OpenAI API key niet geconfigureerd' });

    const imagePart = parts.find(p => p.inline_data);
    const textPart = parts.find(p => p.text);

    let genre = "";
    let tags = [];

    // AUTOMATISCHE DETECTIE: Alleen bij de eerste analyse
    if (imagePart && textPart && textPart.text.includes('ORIGINELE')) {
      try {
        const detectResponse = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: 'gpt-4o-mini',
            response_format: { type: "json_object" },
            messages: [
              {
                role: 'system',
                content: `Analyseer de visuele eigenschappen van de afbeelding en geef uitsluitend een JSON-object terug met het meest geschikte 'genre' en een array van 'tags'.
                
                BESCHIKBARE CATEGORIEËN EN HUN TAGS:
                - nature_wildlife: ["sharpness", "high_iso", "action", "birds", "mammals", "clean_bokeh", "forest", "jungle", "dense_vegetation", "distracting_background", "mist", "fog", "negative_space", "soft_light", "serene", "minimalist", "harsh_sunlight", "low_key", "sidelight", "dramatic_shadows", "snow", "rain", "storm", "winter", "high_key", "dreamy", "pastel", "creative", "conceptual", "painterly", "color_shift", "action_wildlife", "hunting", "water_splash"]
                - landscape_seascapes: ["flowers", "tulips", "forest_beams", "vibrant", "fairytale", "colorful", "misty_morning", "clouds", "dramatic_sky", "flat_land", "mills", "stormy", "netherlands", "sea", "ocean", "waves", "rocks", "water_reflection", "long_exposure", "coast"]
                - street_urban: ["night", "neon", "rainy_street", "dark_urban", "reflections", "moody", "monochrome", "black_and_white", "shadow_geometry", "architecture", "daytime_street", "lines", "cinematic_day", "film_look", "vintage", "pastel", "warm_street", "nostalgic"]
                - documentary_travel: ["travel", "culture", "market", "midday_sun", "warm_storytelling", "people_travel", "documentary_street", "human_element", "local_people", "portraits", "earthy_tones", "interaction", "intimate", "monochrome_documentary", "soft_bw", "quiet_scene", "minimalist_bw"]
                - sports_action: ["stadium", "field_sports", "running", "high_speed_action", "vibrant_sports", "athlete_pop", "gym", "fitness", "boxing", "grit", "muscle_definition", "heavy_shadows", "iron", "mountainbike", "trailrun", "motorsport", "forest_action", "speed", "panning", "mud"]
                - commercial_specialist: ["macro", "closeup", "insects", "textures", "flash_lighting", "micro_details", "product", "studio_lighting", "commercial_gear", "reflections", "glass_metal", "clean_retouch"]
                
                Formatvoorbeeld: { "genre": "nature_wildlife", "tags": ["birds", "clean_bokeh", "soft_light"] }`
              },
              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: `data:${imagePart.inline_data.mime_type};base64,${imagePart.inline_data.data}` } }
                ]
              }
            ]
          })
        });

        const detectData = await detectResponse.json();
        const detectedConfig = JSON.parse(detectData.choices[0].message.content);
        genre = detectedConfig.genre;
        tags = detectedConfig.tags;

      } catch (err) {
        console.error("Fout tijdens AI automatische detectie:", err);
      }
    }

    // INTERNE MATCHING MET JOUW EXPERT DATABASE
    if (genre && tags.length > 0) {
      try {
        const jsonPath = path.join(process.cwd(), 'photo_coach_workflows.json');
        if (fs.existsSync(jsonPath)) {
          const fileData = fs.readFileSync(jsonPath, 'utf8');
          const workflowDatabase = JSON.parse(fileData);

          const expertList = workflowDatabase.genres[genre]?.experts || [];
          let bestExpert = null;
          let highestScore = -1;

          expertList.forEach(expert => {
            const matches = expert.trigger_tags.filter(tag => tags.includes(tag)).length;
            if (matches > highestScore) {
              highestScore = matches;
              bestExpert = expert;
            }
          });

          if (!bestExpert && expertList.length > 0) bestExpert = expertList[0];

          if (bestExpert) {
            systemPrompt += `\n\n[SNOOD ENGINE AUTOMATISCHE DETECTIE]
De AI-detector heeft vastgesteld dat dit beeld valt onder het genre '${genre}' met de kenmerken: ${tags.join(', ')}.
Op basis hiervan is de workflow van expert '${bestExpert.name}' geselecteerd.

Gebruik deze specifieke parameters dwingend voor je bewerkingsadvies:
${JSON.stringify(bestExpert.workflow, null, 2)}

Sluit af met de 'Pro Insight': "${bestExpert.pro_insight}"`;
          }
        }
      } catch (jsonErr) {
        console.error("Fout in expert match engine:", jsonErr);
      }
    }

    // MAP PARTS NAAR OPENAI COMPATIBEL FORMAT (Hier zat de mc / oc fout)
    const openAIChatContent = parts.map(p => {
      if (p.inline_data) return { type: 'image_url', image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } };
      if (p.text) return { type: 'text', text: p.text };
    }).filter(Boolean);

    // CORE GPT-4O GENERATOR AANROEP
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o',
        max_tokens: maxTokens || 8192,
        messages: [
          { role: 'system', content: systemPrompt }, 
          { role: 'user', content: openAIChatContent }
        ]
      })
    });

    const d = await r.json();
    if (d.error) return res.status(400).json({ error: d.error.message });
    
    return res.status(200).json({ text: d.choices?.[0]?.message?.content || '', detectedGenre: genre, detectedTags: tags });

  } catch (err) {
    return res.status(500).json({ error: 'Server fout: ' + err.message });
  }
}