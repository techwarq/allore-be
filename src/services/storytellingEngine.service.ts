import GeminiConnector from "./connectors/gemini.connector";




export class StorytellingEngineService {

    private apikey: string;
    private gemini: GeminiConnector;

    constructor(apikey: string = process.env.GEMINI_API_KEY || "") {
        this.apikey = apikey;
        this.gemini = new GeminiConnector(this.apikey);
    }


}