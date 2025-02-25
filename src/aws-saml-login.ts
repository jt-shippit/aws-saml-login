import colors from 'colors/safe'
import fs from 'fs'
import ini from 'ini'
import os from 'os'
import puppeteer from 'puppeteer'
import readline from 'readline-sync'
import {Command} from 'commander'
import {STS} from 'aws-sdk'

const pjson = require('../package.json')

const CREDENTIALS_FILE_PATH = os.homedir() + '/.aws'
const CREDENTIALS_FILE = CREDENTIALS_FILE_PATH + '/credentials'
const CONFIG_FILE_PATH = os.homedir() + '/.config/aws-saml-login'
const CONFIG_FILE = CONFIG_FILE_PATH + '/config'

const program = new Command()

class AWSSamlLogin {

  public static parsePost(postData: string | undefined): any {
    if (!postData) {return {}}

    const args = postData.split('&')

    return args.reduce((acc, arg) => {
      const [key, val] = decodeURIComponent(arg).split('=')
      return Object.assign(acc, {[key]: val})
    }, {})
  }

  private basicAuth: boolean = false
  private basicCreds: any
  private config: any = {}
  private duration: number = 3600
  private loginUrl: string
  private principal: string = ''
  private profile: string
  private profileConfig: any = {}
  private refresh: string
  private role: string = ''
  private roleArn: string = ''

  constructor(args: string[]) {
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
      .arguments('<login_url>')
    program.parse(args)

    if (!program.args.length && !program.opts().refresh) {
      program.outputHelp()
      process.exit(0)
    }

    this.basicAuth = program.opts().basic_auth
    this.duration = parseInt(program.opts().duration, 10)
    this.loginUrl = program.args[0]
    this.profile = program.opts().profile
    this.refresh = program.opts().refresh
    this.roleArn = program.opts().role_arn

    if (this.refresh) {
      this.profile = this.refresh
      if (fs.existsSync(CONFIG_FILE)) {
        this.config = ini.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'))
        this.profileConfig = this.config[this.refresh] || {}
        this.loginUrl = this.profileConfig.loginUrl
        this.role = this.profileConfig.role
        this.principal = this.profileConfig.principal
      }

      if (!this.loginUrl) {
        this.loginUrl = readline.question('\nLogin URL: ')
      }
    }
  }

  public async login() {
    if (this.basicAuth) {
      const username = readline.question('username: ')
      console.log('NOTE: backspace is disabled!')
      const password = readline.question('password: ', {hideEchoBack: true})
      this.basicCreds = {username, password}
    }

    const browser = await puppeteer.launch({
      headless: (this.basicAuth ? true : false),
      userDataDir: '/tmp/aws-saml-login',
      args: [`--window-size=640,480`],
      defaultViewport: {
        width:640,
        height:480
      }
    })

    const pages = await browser.pages()
    const page = pages[0]

    await page.setRequestInterception(true)
    page.on('request', async (req) => {

      const post = AWSSamlLogin.parsePost(req.postData())
      if (post.SAMLResponse) {
        await browser.close()

        if (!this.role || !this.principal) {

          const decoded = Buffer
            .from(post.SAMLResponse, 'base64')
            .toString('ascii')

          const roles = decoded
            .match(/arn:aws:iam.+?(?=<)/g)!
            .map((i) => {
              const [r, p] = i.split(',')
              return {principal: p, role: r}
            })

          let roleMatch
          if (this.roleArn && this.roleArn.length) {
            roleMatch = roles.find((r) => r.role === this.roleArn)
            if (!roleMatch) {
              console.log(`"${this.roleArn}" not an available role.`)
            }
          }

          if (roleMatch) {
            this.role = roleMatch.role
            this.principal = roleMatch.principal
          } else {
            console.log('\nAvailable roles:')
            roles.forEach((r, i) => console.log(`${colors.cyan(i.toString())}: ${r.role}`))
            console.log(' ')

            const selection = readline.question('Which role do you want to use? ')
            const {role, principal} = roles[parseInt(selection, 10)]
            this.role = role
            this.principal = principal
          }

          if (!this.role || !this.principal) {
            console.log('You did not select one of the available roles!')
            process.exit(1)
          }
        }

        const sts = new STS()
        let resp: STS.Types.AssumeRoleWithSAMLResponse = {}
        try {
          resp = await sts.assumeRoleWithSAML({
            DurationSeconds: this.duration,
            PrincipalArn: this.principal,
            RoleArn: this.role,
            SAMLAssertion: post.SAMLResponse,
          }).promise()
        } catch (err) {
          console.log('\n' + colors.red(err.code))
          console.log(err.message)
          console.log('see: https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/STS.html#assumeRoleWithSAML-property')
          process.exit(1)
        }

        if (!resp.Credentials) {
          console.log('Invalid response from AWS!')
          process.exit(1)
        }

        console.log('\nAWS Response:')
        console.log(resp)
        console.log(' ')

        let credentials = {}
        if (fs.existsSync(CREDENTIALS_FILE)) {
          credentials = ini.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf-8')) as object
        }

        if (!this.profile) {

          const profiles = Object.keys(credentials)

          if (profiles.length > 0) {
            console.log('Existing profiles:')
            profiles.forEach((p) => console.log(colors.cyan(p)))
          } else {
            console.log('No profiles found')
          }

          this.profile = readline.question('\nProfile you would like to update (or create): ')
        }

        credentials = Object.assign(credentials, {
          [this.profile]: {
            aws_access_key_id: resp.Credentials!.AccessKeyId,
            aws_secret_access_key: resp.Credentials!.SecretAccessKey,
            aws_session_token: resp.Credentials!.SessionToken,
          },
        })

        if (!fs.existsSync(CREDENTIALS_FILE_PATH)) {
          fs.mkdirSync(CREDENTIALS_FILE_PATH, {recursive: true})
        }
        fs.writeFileSync(CREDENTIALS_FILE, ini.stringify(credentials))
        const expiration = new Date(resp.Credentials!.Expiration)
        console.log(`\nProfile '${colors.cyan(this.profile)}' updated with credentials`)
        console.log('Expires: ', colors.green(expiration.toString()))
        console.log('\nRemember to update your region information in "~/.aws/config"')
        console.log('see: https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-profiles.html')

        // Write to config if we are refreshing
        if (this.refresh) {
          this.config[this.refresh] = {
            loginUrl: this.loginUrl,
            principal: this.principal,
            role: this.role,
          }
          if (!fs.existsSync(CONFIG_FILE_PATH)) {
            fs.mkdirSync(CONFIG_FILE_PATH, {recursive: true})
          }
          fs.writeFileSync(CONFIG_FILE, ini.stringify(this.config))

          console.log(`\nProfile information stored in "${colors.yellow(CONFIG_FILE)}" for future reference`)
        }
      }

      req.continue()
    })

    try {
      if (this.basicAuth) {
        page.authenticate(this.basicCreds)
      }
      await page.goto(this.loginUrl, {timeout: 0})
    } catch (err) {
      if (
        // Always happens if basic auth is not set
        err.message.startsWith('net::ERR_INVALID_AUTH_CREDENTIALS') ||
        // Will happen with successful basic authentication
        err.message.startsWith('Navigation failed because browser has disconnected!')
      ) {
        return
      }

      console.error(err.message)
      console.error(err)
      process.exit(1)
    }
  }
}

export default AWSSamlLogin
