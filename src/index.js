import fs from 'fs-extra';
import path from 'path';
import resolve from 'resolve';
import filedirname from 'filedirname';
const [_, __dirname] = filedirname(new Error());


// markdown parser and html converter
import mdit from 'markdown-it';
import mdcomment from 'markdown-it-inline-comments';
import hljs from "highlight.js";

const md = mdit({
	highlight: function (str, lang) {
		if (lang && hljs.getLanguage(lang)) {
			try {
				return hljs.highlight(str, { language: lang }).value;
			} catch (__) {}
		}

		try {
			return hljs.highlightAuto(str).value;
		} catch (__) {}

		console.error("Syntax highlighting failed!");
		return ''; // use external default escaping
	},
	inline: true
}).use(mdcomment);

// anki deck creation
import AnkiDeck from 'anki-apkg-export';

import Card from './Card.js';
import Image from './Image.js';

export default async function (inputPath, outputPath, options) {
	// check if input file exists
	if (!(await fs.pathExists(inputPath))) {
		console.error(`input file "${inputPath}" not found!`);
		return;
	}
	// read markdown as text
	const markdown = preprocessMarkdown(await fs.readFile(inputPath, 'utf8'), options);
	// tokenize markdown
	const tokens = tokensFromMarkdown(markdown);
	// parse tokens for images
	const images = imagesFromTokens(tokens, inputPath);
	// parse tokens into individual cards
	let cards = cardsFromTokens(tokens, options);
	// default to first heading as deck-name
	if (cards.length) options.deckName = options.deckName || cards[0].headingStr;
	// remove unwanted cards
	cards = filterCards(cards, options);
	// some stats
	if (cards.length < 1) {
		console.error('attempting to generate an empty deck, aborting...');
		return;
	}
	console.log(`found ${cards.length} cards!`);
	// create new anki-deck
	const deck = deckFromCards(cards, images, options);
	// write anki-deck to file
	deck.save().then(zip => {
		fs.writeFileSync(outputPath, zip, 'binary');
		console.log(`Deck has been generated: ${outputPath}`);
	})
	.catch(err => console.log(err.stack || err));
}

export function preprocessMarkdown(md, options){
	// convert $dollar$ LaTeX-Syntax to \(bracket\)-Syntax
	if(!options.ignoreLatexDollarSyntax){
		md = md.split('```').map((md,i) => i % 2 ? md: md.split('$$').reduce((a,b,i) => i % 2 ? `${a}\\\\[${b}` : `${a}\\\\]${b}`)
			.split('$').reduce((a,b,i) => i % 2 ? `${a}\\\\(${b}` : `${a}\\\\)${b}`)).join('```');
	}
	return md;
}

export function tokensFromMarkdown(markdown) {
	// parse markdown to tokens
	try {
		return md.parse(markdown, {});
	} catch (err) {
		console.log('Markdown parsing error: ' + err.stack)
	}
}

export function cardsFromTokens(tokens) {
	// parse tokens into individual cards
	let cards = [];
	let card = new Card();
	let isFront = true;
	tokens.forEach((token, i) => {
		// new heading starts or end of token-array reached
		if ((token.type === 'heading_open' && !isFront) || i === tokens.length - 1) {
			// find the 'parent' card
			const parent = [...cards].reverse().find(c => c.headingLevel < card.headingLevel);
			if(parent) card.setParent(parent);
			// add finished card to array
			cards.push(card);
			// reset variables
			isFront = true;
			card = new Card();
		}
		// push token to front/back
		card[isFront ? 'front' : 'back'].push(token);
		// check if the card should be split at this token
		if(!isFront && token.type === 'inline' && (token.content.trim().includes('<!-- md2apkg split -->'.trim()) || token.content.trim() === '%')){
			// the split token is not needed anymore
			card.back.pop();
			// add everything from the back to the front
			card.front.push(...card.back);
			// clear the backside of the card
			card.back = [];
		}
		// check if the end of the front has been reached
		if (token.type === 'heading_close' && isFront) isFront = false;
	});
	return cards;
}

export function filterCards(cards, options) {
	// remove empty cards
	if (!options.includeEmpty) cards = cards.filter(card => card.back.length);
	// remove ignored cards
	cards = cards.filter(card => !card.back.some(token => token.type === 'inline' && token.content.trim().includes('<!-- md2apkg ignore-card -->'.trim())));
	// remove cards from unwanted heading levels
	return cards.filter(card => !(options.ignoreLevels || []).includes(card.headingLevel));
}

export function deckFromCards(cards, images, options) {
	// get path to highlight.js cdn directory
	let cssPath = path.dirname(resolve.sync('@highlightjs/cdn-assets/package.json', { basedir: __dirname }));
	// construct path to highlight.js stylesheet
	cssPath = path.resolve(cssPath, `styles/${options.codeStyle}.min.css`);
	// load syntax-highlighting css
	let css = fs.readFileSync(cssPath, 'utf8');
	// remove comment from css, because that breaks things for some reason
	css = css.replace(/\/\*[\s\S]*\*\//gm, '');
	// load some more default css styles
	css += fs.readFileSync(path.resolve(__dirname, `./style.css`),'utf8');
	// create new deck
	const apkg = AnkiDeck(options.deckName, { css });
	console.log(`deck initialized!`);
	// add media files to deck
	images.forEach(image => {
		try {
			apkg.addMedia(image.filteredPath, fs.readFileSync(image.filePath));
		} catch (err) {
			console.error('image import error: ' + err.stack);
		}
	});
	// add cards to deck (convert tokens to html)
	let allTags = new Set();
	cards.forEach(card => {
		const { front, back } = card.renderToHTML(md, options);
		const tags = card.tags;
		tags.forEach(tag => allTags.add(tag));
		apkg.addCard(front, back, { tags });
	});
	console.log(`added ${cards.length} cards to the deck!`);
	console.log(`added ${images.length} images to the deck!`);
	console.log(`added ${allTags.size} tags to the deck!`);
	return apkg;
}

export function imagesFromTokens(tokens, inputPath) {
	let images = [];
	tokens.forEach((token) => {
		if (token.type === 'image') {
			// find images in tokens and save them to a list
			let attrPath = token.attrGet('src');
			// skip external images
			if (attrPath.includes('://')) return;
			// make the image path relative
			let filePath = path.join(path.dirname(inputPath), attrPath);
			// replace \ with / (in case we're on a windows system)
			filePath = filePath.split(path.sep).join(path.posix.sep);
			let image = new Image(filePath);
			// fix the image
			token.attrSet('src', image.filteredPath)
			images.push(image);
		}
		if (token.type === 'inline') {
			// recursively find images in children
			images.push(imagesFromTokens(token.children, inputPath));
		}
	});

	// flatten the list to a depth of 1
	images = images.flat();
	// this process produces a lot of empty entries, remove them
	images = images.filter(image => image.filePath.length > 0);

	// only return unique images
	return [...new Set(images)];
}
