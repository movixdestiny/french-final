import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase
const supabaseUrl = 'https://tjujpqefxajuoanvzmhc.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRqdWpwcWVmeGFqdW9hbnZ6bWhjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTcyNjQ2MzIxNywiZXhwIjoyMDQyMDM5MjE3fQ.CjrAKuVkQLx43t6FdB0SpeVioJKP7eJgbPk7FUQ59Lg';
const supabase = createClient(supabaseUrl, supabaseKey);

const API_KEYS = [
  '206f66123cmsh234489eccabe66ap1d53fejsnbd5b11c15c9c',
  '90aa91617bmsh9bb3a55897c966fp115852jsn95393d75cf7c',
  '2561b454f4msh3bc2141a8698d7ap111c2bjsn95a0edaf8951',
  '879c95b8b8msh2afbe1d4392c461p1b7e5bjsne48007afe996',
  'a4c18d0c20mshb3cb645ee293e87p18c0f9jsn70549dd6abf4',
  '8a8c10682fmsh0898cd01a74d121p107f88jsndba86e2fef2e',
];

async function fetchWithRetry(url, headers, retryIndex = 0) {
  if (retryIndex >= API_KEYS.length) {
    throw new Error('All API keys have failed.');
  }

  const apiKey = API_KEYS[retryIndex];
  const currentHeaders = { ...headers, 'x-rapidapi-key': apiKey };

  try {
    console.log(`Fetching data from API with key: ${apiKey}`);
    const response = await fetch(url, { headers: currentHeaders });
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }

    return await response.json();
  } catch (error) {
    console.error(`Error with API key ${apiKey}: ${error.message}`);
    return fetchWithRetry(url, headers, retryIndex + 1);
  }
}

export default async function handler(req, res) {
  const { tmdbid } = req.query;

  if (!tmdbid) {
    return res.status(400).json({ error: 'TMDB ID is required' });
  }

  try {
    // Check Supabase for existing TMDB ID
    const { data: existingEntry, error: selectError } = await supabase
      .from('api')
      .select('netflixId')
      .eq('tmdbId', tmdbid)
      .single();

    if (selectError) {
      throw selectError;
    }

    if (existingEntry) {
      const { netflixId } = existingEntry;

      if (netflixId === 'none') {
        // If the stored value is 'none', skip the API check and return an error
        return res.status(404).json({ error: 'Netflix ID not available for this TMDB ID' });
      } else {
        // If a Netflix ID is found, proceed with processing
        return processNetflixId(res, netflixId);
      }
    }

    // If TMDB ID is not found in Supabase, make the API request
    const apiUrl = `https://streaming-availability.p.rapidapi.com/get?output_language=en&tmdb_id=movie%2F${tmdbid}`;
    const apiHeaders = {
      'Accept': 'application/json',
      'x-rapidapi-host': 'streaming-availability.p.rapidapi.com'
    };

    const data = await fetchWithRetry(apiUrl, apiHeaders);

    console.log('API Response:', JSON.stringify(data, null, 2));

    if (!data.result || !data.result.streamingInfo) {
      // Save "none" to Supabase if no streaming info is found
      await supabase
        .from('api')
        .upsert({ tmdbId: tmdbid, netflixId: 'none' });

      return res.status(404).json({ error: 'Netflix ID not found in streaming info' });
    }

    let netflixId = 'none';
    for (const region in data.result.streamingInfo) {
      const services = data.result.streamingInfo[region];
      if (Array.isArray(services)) {
        for (const service of services) {
          if (service.service === 'netflix' && service.videoLink) {
            netflixId = service.videoLink.match(/watch\/(\d+)/);
            if (netflixId) {
              netflixId = netflixId[1];
              break;
            }
          }
        }
        if (netflixId !== 'none') break;
      }
    }

    // Save the result to Supabase
    await supabase
      .from('api')
      .upsert({ tmdbId: tmdbid, netflixId });

    if (netflixId === 'none') {
      return res.status(404).json({ error: 'Netflix ID not found in streaming info' });
    }

    // Proceed with processing using the retrieved Netflix ID
    return processNetflixId(res, netflixId);

  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

// Helper function to process the Netflix ID and generate the m3u8 response
async function processNetflixId(res, netflixId) {
  const m3u8Url = `https://proxy.smashystream.com/proxy/echo1/https://pcmirror.cc/hls/${netflixId}.m3u8`;
  console.log(`Fetching M3U8 playlist from URL: ${m3u8Url}`);
  const m3u8Response = await fetch(m3u8Url);
  const m3u8Data = await m3u8Response.text();

  let frenchAudioUrl = null;
  let videoUrl = null;

  const lines = m3u8Data.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    if (line.startsWith('#EXT-X-MEDIA') && line.includes('LANGUAGE="fra"')) {
      const audioMatch = line.match(/URI="([^"]+)"/);
      if (audioMatch) {
        frenchAudioUrl = audioMatch[1];
      }
    }

    if (line.startsWith('#EXT-X-STREAM-INF')) {
      if (line.includes('RESOLUTION=1280x720')) {
        const videoUrlLine = lines[i + 1].trim();
        if (videoUrlLine) {
          videoUrl = videoUrlLine;
        }
      }
    }

    i++;
  }

  if (!frenchAudioUrl || !videoUrl) {
    throw new Error('French audio URL or 720p video URL not found in M3U8 playlist');
  }

  const filteredM3U8 = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="fra",NAME="French",DEFAULT=NO,URI="${frenchAudioUrl}"
#EXT-X-STREAM-INF:BANDWIDTH=40000000,AUDIO="aac",DEFAULT=YES,RESOLUTION=1280x720,CLOSED-CAPTIONS=NONE
${videoUrl}`;

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Content-Disposition', 'inline; filename="stream.m3u8"');
  res.status(200).send(filteredM3U8);
}
