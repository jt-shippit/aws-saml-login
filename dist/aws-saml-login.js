"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const safe_1 = __importDefault(require("colors/safe"));
const fs_1 = __importDefault(require("fs"));
const ini_1 = __importDefault(require("ini"));
const os_1 = __importDefault(require("os"));
const puppeteer_1 = __importDefault(require("puppeteer"));
const readline_sync_1 = __importDefault(require("readline-sync"));
const commander_1 = require("commander");
const aws_sdk_1 = require("aws-sdk");
const pjson = require('../package.json');
const CREDENTIALS_FILE_PATH = os_1.default.homedir() + '/.aws';
const CREDENTIALS_FILE = CREDENTIALS_FILE_PATH + '/credentials';
const CONFIG_FILE_PATH = os_1.default.homedir() + '/.config/aws-saml-login';
const CONFIG_FILE = CONFIG_FILE_PATH + '/config';
const program = new commander_1.Command();
class AWSSamlLogin {
    constructor(args) {
        this.basicAuth = false;
        this.config = {};
        this.duration = 3600;
        this.principal = '';
        this.profileConfig = {};
        this.role = '';
        this.roleArn = '';
        program
            .version(pjson.version)
            .description(pjson.description)
            .option('-b, --basic_auth', `use basic auth from the cli to login, this will run the browser in
                              headless mode`)
            .option('-d, --duration <secs>', 'session duration in seconds', '3600')
            .option('-p, --profile <profile_name>', 'default profile to use')
            .option('-r, --refresh <profile_name>', `attempts to refresh an existing profile using config options saved
                              in "~/.config/aws-saml-login/config".  Will create the entry if it
                              does not exist.\n`)
            .option('-a, --role_arn <role_arn>', `role ARN to login as`)
            .arguments('<login_url>');
        program.parse(args);
        if (!program.args.length && !program.opts().refresh) {
            program.outputHelp();
            process.exit(0);
        }
        this.basicAuth = program.opts().basic_auth;
        this.duration = parseInt(program.opts().duration, 10);
        this.loginUrl = program.args[0];
        this.profile = program.opts().profile;
        this.refresh = program.opts().refresh;
        this.roleArn = program.opts().role_arn;
        if (this.refresh) {
            this.profile = this.refresh;
            if (fs_1.default.existsSync(CONFIG_FILE)) {
                this.config = ini_1.default.parse(fs_1.default.readFileSync(CONFIG_FILE, 'utf-8'));
                this.profileConfig = this.config[this.refresh] || {};
                this.loginUrl = this.profileConfig.loginUrl;
                this.role = this.profileConfig.role;
                this.principal = this.profileConfig.principal;
            }
            if (!this.loginUrl) {
                this.loginUrl = readline_sync_1.default.question('\nLogin URL: ');
            }
        }
    }
    static parsePost(postData) {
        if (!postData) {
            return {};
        }
        const args = postData.split('&');
        return args.reduce((acc, arg) => {
            const [key, val] = decodeURIComponent(arg).split('=');
            return Object.assign(acc, { [key]: val });
        }, {});
    }
    login() {
        return __awaiter(this, void 0, void 0, function* () {
            if (this.basicAuth) {
                const username = readline_sync_1.default.question('username: ');
                console.log('NOTE: backspace is disabled!');
                const password = readline_sync_1.default.question('password: ', { hideEchoBack: true });
                this.basicCreds = { username, password };
            }
            const browser = yield puppeteer_1.default.launch({
                headless: (this.basicAuth ? true : false),
                userDataDir: '/tmp/aws-saml-login',
                args: [`--window-size=640,480`],
                defaultViewport: {
                    width: 640,
                    height: 480
                }
            });
            const pages = yield browser.pages();
            const page = pages[0];
            yield page.setRequestInterception(true);
            page.on('request', (req) => __awaiter(this, void 0, void 0, function* () {
                const post = AWSSamlLogin.parsePost(req.postData());
                if (post.SAMLResponse) {
                    yield browser.close();
                    if (!this.role || !this.principal) {
                        const decoded = Buffer
                            .from(post.SAMLResponse, 'base64')
                            .toString('ascii');
                        const roles = decoded
                            .match(/arn:aws:iam.+?(?=<)/g)
                            .map((i) => {
                            const [r, p] = i.split(',');
                            return { principal: p, role: r };
                        });
                        let roleMatch;
                        if (this.roleArn && this.roleArn.length) {
                            roleMatch = roles.find((r) => r.role === this.roleArn);
                            if (!roleMatch) {
                                console.log(`"${this.roleArn}" not an available role.`);
                            }
                        }
                        if (roleMatch) {
                            this.role = roleMatch.role;
                            this.principal = roleMatch.principal;
                        }
                        else {
                            console.log('\nAvailable roles:');
                            roles.forEach((r, i) => console.log(`${safe_1.default.cyan(i.toString())}: ${r.role}`));
                            console.log(' ');
                            const selection = readline_sync_1.default.question('Which role do you want to use? ');
                            const { role, principal } = roles[parseInt(selection, 10)];
                            this.role = role;
                            this.principal = principal;
                        }
                        if (!this.role || !this.principal) {
                            console.log('You did not select one of the available roles!');
                            process.exit(1);
                        }
                    }
                    const sts = new aws_sdk_1.STS();
                    let resp = {};
                    try {
                        resp = yield sts.assumeRoleWithSAML({
                            DurationSeconds: this.duration,
                            PrincipalArn: this.principal,
                            RoleArn: this.role,
                            SAMLAssertion: post.SAMLResponse,
                        }).promise();
                    }
                    catch (err) {
                        console.log('\n' + safe_1.default.red(err.code));
                        console.log(err.message);
                        console.log('see: https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/STS.html#assumeRoleWithSAML-property');
                        process.exit(1);
                    }
                    if (!resp.Credentials) {
                        console.log('Invalid response from AWS!');
                        process.exit(1);
                    }
                    console.log('\nAWS Response:');
                    console.log(resp);
                    console.log(' ');
                    let credentials = {};
                    if (fs_1.default.existsSync(CREDENTIALS_FILE)) {
                        credentials = ini_1.default.parse(fs_1.default.readFileSync(CREDENTIALS_FILE, 'utf-8'));
                    }
                    if (!this.profile) {
                        const profiles = Object.keys(credentials);
                        if (profiles.length > 0) {
                            console.log('Existing profiles:');
                            profiles.forEach((p) => console.log(safe_1.default.cyan(p)));
                        }
                        else {
                            console.log('No profiles found');
                        }
                        this.profile = readline_sync_1.default.question('\nProfile you would like to update (or create): ');
                    }
                    credentials = Object.assign(credentials, {
                        [this.profile]: {
                            aws_access_key_id: resp.Credentials.AccessKeyId,
                            aws_secret_access_key: resp.Credentials.SecretAccessKey,
                            aws_session_token: resp.Credentials.SessionToken,
                        },
                    });
                    if (!fs_1.default.existsSync(CREDENTIALS_FILE_PATH)) {
                        fs_1.default.mkdirSync(CREDENTIALS_FILE_PATH, { recursive: true });
                    }
                    fs_1.default.writeFileSync(CREDENTIALS_FILE, ini_1.default.stringify(credentials));
                    const expiration = new Date(resp.Credentials.Expiration);
                    console.log(`\nProfile '${safe_1.default.cyan(this.profile)}' updated with credentials`);
                    console.log('Expires: ', safe_1.default.green(expiration.toString()));
                    console.log('\nRemember to update your region information in "~/.aws/config"');
                    console.log('see: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-profiles.html');
                    // Write to config if we are refreshing
                    if (this.refresh) {
                        this.config[this.refresh] = {
                            loginUrl: this.loginUrl,
                            principal: this.principal,
                            role: this.role,
                        };
                        if (!fs_1.default.existsSync(CONFIG_FILE_PATH)) {
                            fs_1.default.mkdirSync(CONFIG_FILE_PATH, { recursive: true });
                        }
                        fs_1.default.writeFileSync(CONFIG_FILE, ini_1.default.stringify(this.config));
                        console.log(`\nProfile information stored in "${safe_1.default.yellow(CONFIG_FILE)}" for future reference`);
                    }
                }
                req.continue();
            }));
            try {
                if (this.basicAuth) {
                    page.authenticate(this.basicCreds);
                }
                yield page.goto(this.loginUrl, { timeout: 0 });
            }
            catch (err) {
                if (
                // Always happens if basic auth is not set
                err.message.startsWith('net::ERR_INVALID_AUTH_CREDENTIALS') ||
                    // Will happen with successful basic authentication
                    err.message.startsWith('Navigation failed because browser has disconnected!')) {
                    return;
                }
                console.error(err.message);
                console.error(err);
                process.exit(1);
            }
        });
    }
}
exports.default = AWSSamlLogin;
//# sourceMappingURL=aws-saml-login.js.map