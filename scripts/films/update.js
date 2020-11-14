#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const unzipper = require('unzipper');
const csvToJson = require('csvtojson');
const SQL = require('sql-template-strings');

require('dotenv').config()
const db = require('./db');
const console = require('./log');

const DIR = path.resolve('./');
const SETTINGS_URL = 'https://letterboxd.com/settings/data';
const DOWNLOAD_URL = 'https://letterboxd.com/data/export';

const password = process.env.LETTERBOXD_KEY;

async function insertRecords(records, db) {
  let query;
  for (let i = 0; i < records.length; i++) {
    const first = i === 0;
    const last = i === records.length;
    const {name, year, link, status, date_updated} = records[i];

    if (first) {
      query = SQL`INSERT INTO films (name, year, link, status, date_updated) VALUES (${name}, ${year}, ${link}, ${status}, ${date_updated})`;
    } else {
      const q = SQL`,(${name}, ${year}, ${link}, ${status}, ${date_updated})`;
      try {
        query = query.append(q);
      } catch (error) {
        console.error('Failed to build query');
        console.error(JSON.stringify(q));
        console.error(error);
      }
    }
  }

  try {
    await db.runQuery(query);
  } catch (error) {
    console.error('Failed to run query');
    console.error(JSON.stringify(query));
    console.error(error);
  }
  return;
}

async function downloadBlob(page) {
  const data = await page.evaluate(async () => {
    const resp = await window.fetch('https://letterboxd.com/data/export');

    if (!resp.ok) {
      throw new Error(resp.statusText);
    }

    const data = await resp.blob();
    const reader = new FileReader();
    return new Promise(resolve => {
      reader.addEventListener('loadend', () =>
        resolve({
          url: reader.result,
          mime: resp.headers.get('Content-Type'),
        }),
      );
      reader.readAsDataURL(data);
    });
  });

  return {
    buffer: Buffer.from(data.url.split(',')[1], 'base64'),
    mime: data.mime,
  };
}

async function scrapeLetterboxd() {
  try {
    const browser = await puppeteer.launch({
      executablePath: '/usr/bin/chromium',
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();
    await page.goto(SETTINGS_URL);

    let pageTitle = await page.title();

    if (pageTitle.includes('Sign In')) {
      console.log(`Signing in as jackreid`);
    }

    const signInForm = await page.$('#signin-form');
    const usernameBox = await signInForm.$('#signin-username');
    const passwordBox = await signInForm.$('#signin-password');
    const submitButton = await signInForm.$('input[type=submit]');

    await usernameBox.type('jackreid');
    await passwordBox.type(password);

    const [response] = await Promise.all([
      page.waitForNavigation(),
      passwordBox.press('Enter'),
    ]);

    pageTitle = await page.title();
    if (pageTitle.includes('Update your settings')) {
      console.log('Signed in');
    }

    console.log('Downloading archive');
    const blob = await downloadBlob(page);

    console.log('Unzipping archive');
    const files = await unzip(blob.buffer);

    await new Promise(r => setTimeout(r, 2000));
    console.log('Scrape successful');

    await browser.close();
    return files;
  } catch (error) {
    console.error('Scraping error');
    console.error(error);
    throw error;
  }
}

async function unzip(buffer) {
  const res = await unzipper.Open.buffer(buffer);
  const fileStrings = {};
  for (let i = 0; i < res.files.length; i++) {
    const fileBuffer = await res.files[i].buffer();
    const fileString = fileBuffer.toString();
    fileStrings[res.files[i].path] = fileString;
  }
  return fileStrings;
}

function transformFilms(filmArray, status) {
  return filmArray.map(film => ({
    date_updated: film['Watched Date'] || film.Date,
    name: film.Name,
    year: film.Year || null,
    link: film['Letterboxd URI'],
    rating: film.Rating || null,
    status,
  })).filter(film => (
    film.name && film.year && film.link
  ));
}

async function fetchFilms() {
  const files = await scrapeLetterboxd();
  console.log('Converting CSV to JSON');
  const watched = transformFilms(
    await csvToJson().fromString(files['diary.csv']),
    'watched',
  );
  const towatch = transformFilms(
    await csvToJson().fromString(files['watchlist.csv']),
    'towatch',
  );
  return {watched, towatch};
}

(async function main() {
  try {
    console.log('Starting update script');
    const {watched, towatch} = await fetchFilms();
    const merged = [...watched, ...towatch];
    await db.runQuery(SQL`DELETE FROM films`);
    const res = await insertRecords(merged, db);
    console.log('Finished update script');
    process.exit(0);
  } catch (error) {
    console.error(error);
    console.log('Ended on critical error');
    process.exit(1);
  }
})();

module.exports = {fetchFilms};
