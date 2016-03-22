/* @flow */
import path from 'path';
import {describe, it} from 'mocha';
import {assert} from 'chai';
import deepcopy from 'deepcopy';
import sinon from 'sinon';
import FirefoxProfile from 'firefox-profile';

import * as firefox from '../../src/firefox';
import {onlyInstancesOf, WebExtError} from '../../src/errors';
import fs from 'mz/fs';
import {withTempDir} from '../../src/util/temp-dir';
import {fixturePath, makeSureItFails} from '../helpers';
import {basicManifest} from '../test-util/test.manifest';
import {defaultFirefoxEnv} from '../../src/firefox/';


describe('firefox', () => {

  describe('run', () => {

    const fakeProfile = {
      path: () => '/dev/null/some-profile-path',
    };

    const fakeFirefoxProcess = {
      on: (eventName, callback) => {
        if (eventName === 'close') {
          // Immediately "emit" a close event to complete the test.
          callback();
        }
      },
      stdout: {on: () => {}},
      stderr: {on: () => {}},
    };

    function createFakeFxRunner(firefoxOverrides={}) {
      let firefox = {
        ...deepcopy(fakeFirefoxProcess),
        ...firefoxOverrides,
      };
      return sinon.spy(() => Promise.resolve({
        args: [],
        process: firefox,
      }));
    }

    it('executes the Firefox runner with a given profile', () => {
      let runner = createFakeFxRunner();
      return firefox.run(fakeProfile, {fxRunner: runner})
        .then(() => {
          assert.equal(runner.called, true);
          assert.equal(runner.firstCall.args[0].profile,
                       fakeProfile.path());
        });
    });

    it('sets up a Firefox process environment', () => {
      let runner = createFakeFxRunner();
      // Make sure it passes through process environment variables.
      process.env._WEB_EXT_FIREFOX_ENV_TEST = 'thing';
      return firefox.run(fakeProfile, {fxRunner: runner})
        .then(() => {
          let declaredEnv = runner.firstCall.args[0].env;
          for (let key in defaultFirefoxEnv) {
            assert.equal(declaredEnv[key], defaultFirefoxEnv[key]);
          }
          assert.equal(declaredEnv._WEB_EXT_FIREFOX_ENV_TEST, 'thing');
        });
    });

    it('fails on a firefox error', () => {
      let someError = new Error('some internal firefox error');
      let runner = createFakeFxRunner({
        on: (eventName, callback) => {
          if (eventName === 'error') {
            // Immediately "emit" an error event.
            callback(someError);
          }
        },
      });

      return firefox.run(fakeProfile, {fxRunner: runner})
        .then(makeSureItFails())
        .catch((error) => {
          assert.equal(error.message, someError.message);
        });
    });

    it('passes a custom Firefox binary when specified', () => {
      let runner = createFakeFxRunner();
      let firefoxBinary = '/pretend/path/to/firefox-bin';
      return firefox.run(fakeProfile, {fxRunner: runner, firefoxBinary})
        .then(() => {
          assert.equal(runner.called, true);
          assert.equal(runner.firstCall.args[0].binary,
                       firefoxBinary);
        });
    });

  });

  describe('copyProfile', () => {

    function withBaseProfile(callback) {
      return withTempDir(
        (tmpDir) => {
          let baseProfile = new FirefoxProfile({
            destinationDirectory: tmpDir.path(),
          });
          return callback(baseProfile);
        }
      );
    }

    it('copies a profile', () => withBaseProfile(
      (baseProfile) => {
        baseProfile.setPreference('webext.customSetting', true);
        baseProfile.updatePreferences();

        return firefox.copyProfile(baseProfile.path(),
          {configureThisProfile: (profile) => Promise.resolve(profile)})
          .then((profile) => fs.readFile(profile.userPrefs))
          .then((userPrefs) => {
            assert.include(userPrefs.toString(), 'webext.customSetting');
          });
      }
    ));

    it('requires a valid profile directory', () => {
      // This stubs out the code that looks for a named
      // profile because on Travis CI there will not be a Firefox
      // user directory.
      let copyFromUserProfile = sinon.spy(
        (config, cb) => cb(new Error('simulated: could not find profile')));

      return firefox.copyProfile('/dev/null/non_existent_path',
        {
          copyFromUserProfile,
          configureThisProfile: (profile) => Promise.resolve(profile),
        })
        .then(makeSureItFails())
        .catch(onlyInstancesOf(WebExtError, (error) => {
          assert.equal(copyFromUserProfile.called, true);
          assert.match(
            error.message,
            /Could not copy Firefox profile from .*non_existent_path/);
        }));
    });

    it('can copy a profile by name', () => {
      let name = 'some-fake-firefox-profile-name';
      // Fake profile object:
      let profileToCopy = {
        defaultPreferences: {
          thing: 'value',
        },
      };
      let copyFromUserProfile = sinon.spy(
        (config, callback) => callback(null, profileToCopy));

      return firefox.copyProfile(name,
        {
          copyFromUserProfile,
          configureThisProfile: (profile) => Promise.resolve(profile),
        })
        .then((profile) => {
          assert.equal(copyFromUserProfile.called, true);
          assert.equal(copyFromUserProfile.firstCall.args[0].name, name);
          assert.equal(profile.defaultPreferences.thing,
                       profileToCopy.defaultPreferences.thing);
        });
    });

    it('configures the copied profile', () => withBaseProfile(
      (baseProfile) => {
        let app = 'fennec';
        let configureThisProfile =
          sinon.spy((profile) => Promise.resolve(profile));

        return firefox.copyProfile(baseProfile.path(),
          {configureThisProfile, app})
          .then((profile) => {
            assert.equal(configureThisProfile.called, true);
            assert.equal(configureThisProfile.firstCall.args[0], profile);
            assert.equal(configureThisProfile.firstCall.args[1].app, app);
          });
      }
    ));

  });

  describe('createProfile', () => {

    it('resolves with a profile object', () => {
      return firefox.createProfile(
        {configureThisProfile: (profile) => Promise.resolve(profile)})
        .then((profile) => {
          assert.instanceOf(profile, FirefoxProfile);
        });
    });

    it('creates a Firefox profile', () => {
      // This is a quick and paranoid sanity check that the FirefoxProfile
      // object is real and has some preferences.
      return firefox.createProfile(
        {configureThisProfile: (profile) => Promise.resolve(profile)})
        .then((profile) => {
          profile.updatePreferences();
          return fs.readFile(path.join(profile.path(), 'user.js'));
        })
        .then((prefFile) => {
          // Check for some default pref set by FirefoxProfile.
          assert.include(prefFile.toString(),
                         '"startup.homepage_welcome_url", "about:blank"');
        });
    });

    it('configures a profile', () => {
      let configureThisProfile =
        sinon.spy((profile) => Promise.resolve(profile));
      let app = 'fennec';
      return firefox.createProfile({app, configureThisProfile})
        .then((profile) => {
          assert.equal(configureThisProfile.called, true);
          assert.equal(configureThisProfile.firstCall.args[0], profile);
          assert.equal(configureThisProfile.firstCall.args[1].app, app);
        });
    });

  });

  describe('configureProfile', () => {

    function withTempProfile(callback) {
      return withTempDir((tmpDir) => {
        let profile = new FirefoxProfile({
          destinationDirectory: tmpDir.path(),
        });
        return callback(profile);
      });
    }

    it('resolves with a profile', () => withTempProfile(
      (profile) => {
        let fakePrefGetter = sinon.stub().returns({});
        return firefox.configureProfile(profile, {getPrefs: fakePrefGetter})
          .then((profile) => {
            assert.instanceOf(profile, FirefoxProfile);
          });
      }
    ));

    it('sets Firefox preferences', () => withTempProfile(
      (profile) => {
        let fakePrefGetter = sinon.stub().returns({});
        return firefox.configureProfile(profile, {getPrefs: fakePrefGetter})
          .then(() => {
            assert.equal(fakePrefGetter.firstCall.args[0], 'firefox');
          });
      }
    ));

    it('sets Fennec preferences', () => withTempProfile(
      (profile) => {
        let fakePrefGetter = sinon.stub().returns({});
        return firefox.configureProfile(
          profile, {
            getPrefs: fakePrefGetter,
            app: 'fennec',
          })
          .then(() => {
            assert.equal(fakePrefGetter.firstCall.args[0], 'fennec');
          });
      }
    ));

    it('writes new preferences', () => withTempProfile(
      (profile) => {
        // This is a quick sanity check that real preferences were
        // written to disk.
        return firefox.configureProfile(profile)
          .then((profile) => fs.readFile(path.join(profile.path(), 'user.js')))
          .then((prefFile) => {
            // Check for some pref set by configureProfile().
            assert.include(prefFile.toString(),
                           '"devtools.debugger.remote-enabled", true');
          });
      }
    ));

  });

  describe('installExtension', () => {

    function setUp(testPromise: Function) {
      return withTempDir(
        (tmpDir) => {
          let data = {
            extensionPath: fixturePath('minimal_extension-1.0.xpi'),
            profile: undefined,
            profileDir: path.join(tmpDir.path(), 'profile'),
          };
          return fs.mkdir(data.profileDir)
            .then(() => {
              data.profile = new FirefoxProfile({
                destinationDirectory: data.profileDir,
              });
            })
            .then(() => testPromise(data));
        });
    }

    function installBasicExt(data, config={}) {
      return firefox.installExtension({
        manifestData: basicManifest,
        profile: data.profile,
        extensionPath: data.extensionPath,
        ...config,
      });
    }

    it('installs an extension file into a profile', () => setUp(
      (data) => {
        return installBasicExt(data)
          .then(() => fs.readdir(data.profile.extensionsDir))
          .then((files) => {
            assert.deepEqual(
              files, ['basic-manifest@web-ext-test-suite.xpi']);
          });
      }
    ));

    it('re-uses an existing extension directory', () => setUp(
      (data) => {
        return fs.mkdir(path.join(data.profile.extensionsDir))
          .then(() => installBasicExt(data))
          .then(() => fs.stat(data.profile.extensionsDir));
      }
    ));

    it('checks for an empty extensionsDir', () => setUp(
      (data) => {
        data.profile.extensionsDir = undefined;
        return installBasicExt(data)
          .then(makeSureItFails())
          .catch(onlyInstancesOf(WebExtError, (error) => {
            assert.match(error.message, /unexpectedly empty/);
          }));
      }
    ));

  });

});
