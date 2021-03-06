import _ from 'lodash';

import { PAID_ADMIN_ROLE, MAILBOX_PASSWORD_KEY } from '../../constants';

/* @ngInject */
function upgradeKeys($log, $injector, gettextCatalog, Key, organizationApi, passwords, pmcw, secureSessionStorage) {
    /**
     * Reformat organization keys
     * @param  {String} password
     * @param  {String} oldSaltedPassword
     * @param  {Object} user
     * @return {Promise}
     */
    function manageOrganizationKeys(password = '', oldSaltedPassword = '', user = {}) {
        if (user.Role === PAID_ADMIN_ROLE) {
            // Get organization key
            return organizationApi
                .getKeys()
                .then(({ data = {} } = {}) => {
                    const encryptPrivateKey = data.PrivateKey;
                    const [{ Email }] = $injector.get('addressesModel').getByUser(user) || {};
                    return pmcw
                        .decryptPrivateKey(encryptPrivateKey, oldSaltedPassword)
                        .then((pkg) => pmcw.reformatKey(pkg, Email, password), () => 0);
                })
                .catch(({ data = {} } = {}) => {
                    throw new Error(
                        data.Error || gettextCatalog.getString('Unable to get organization keys', null, 'Error')
                    );
                });
        }
        return Promise.resolve(0);
    }

    const collectUserKeys = ({ Keys = [] } = {}) => {
        const addresses = $injector.get('addressesModel').get();

        return Keys.reduce(
            (acc, key) => {
                acc.keys.push(key);
                let foundKey = null;
                addresses.forEach((address) => {
                    foundKey = _.find(address.Keys, { Fingerprint: key.Fingerprint });
                    if (foundKey) {
                        acc.emails[key.ID] = address.Email;
                    }
                });

                if (!foundKey) {
                    acc.emails[key.ID] = addresses[0].Email;
                }
                return acc;
            },
            { keys: [], emails: {} }
        );
    };

    const collectAddressKeys = () => {
        const addresses = $injector.get('addressesModel').get();
        return addresses.reduce(
            (acc, { Keys = [], Email } = {}) => {
                Keys.forEach((key) => {
                    acc.keys.push(key);
                    acc.emails[key.ID] = Email;
                });
                return acc;
            },
            { keys: [], emails: {} }
        );
    };

    /**
     * Reformat user keys
     * @param  {String} password
     * @param  {String} oldSaltedPassword
     * @param  {Object} user
     * @return {Promise}
     */
    function manageUserKeys(password = '', oldSaltedPassword = '', user = {}) {
        const keysUser = collectUserKeys(user);
        const keysAddresses = collectAddressKeys();
        const inputKeys = [].concat(keysUser.keys, keysAddresses.keys);
        const emailAddresses = _.extend({}, keysUser.emails, keysAddresses.emails);

        // Reformat all keys, if they can be decrypted
        const promises = inputKeys.map(({ PrivateKey, ID }) => {
            // Decrypt private key with the old mailbox password
            return pmcw.decryptPrivateKey(PrivateKey, oldSaltedPassword).then((pkg) => ({ ID, pkg }));
        });

        return promises.map((promise) => {
            return (
                promise
                    // Encrypt the key with the new mailbox password
                    .then(({ ID, pkg }) => {
                        return pmcw
                            .reformatKey(pkg, emailAddresses[ID], password)
                            .then((PrivateKey) => ({ ID, PrivateKey }));
                    })
                    // Cannot decrypt, return 0 (not an error)
                    .then(null, (error) => ($log.error(error), 0))
            );
        });
    }
    /**
     * Send newly reformatted keys to backend
     * @param  {Array} keys
     * @param  {String} keySalt
     * @param  {Object} organizationKey
     * @param  {String} loginPassword
     * @return {Promise}
     */
    function sendNewKeys({ keys = [], keySalt = '', organizationKey = 0, loginPassword = '' }) {
        const keysFiltered = keys.filter((key) => key !== 0);

        if (keysFiltered.length === 0) {
            throw new Error(gettextCatalog.getString('No keys to update', null, 'Error'));
        }

        const payload = { KeySalt: keySalt, Keys: keysFiltered };
        if (organizationKey !== 0) {
            payload.OrganizationKey = organizationKey;
        }

        return Key.upgrade(payload, loginPassword);
    }

    return ({ mailboxPassword = '', oldSaltedPassword = '', user = {} }) => {
        let passwordComputed = '';
        const keySalt = passwords.generateKeySalt();
        const loginPassword = user.PasswordMode === 1 ? mailboxPassword : '';

        return passwords
            .computeKeyPassword(mailboxPassword, keySalt)
            .then((password) => {
                passwordComputed = password;
                const collection = manageUserKeys(passwordComputed, oldSaltedPassword, user);
                const promises = [].concat(
                    manageOrganizationKeys(passwordComputed, oldSaltedPassword, user),
                    collection
                );
                return Promise.all(promises);
            })
            .then(([organizationKey, ...keys]) =>
                sendNewKeys({
                    keys,
                    keySalt,
                    organizationKey,
                    loginPassword
                })
            )
            .then(() => {
                secureSessionStorage.setItem(MAILBOX_PASSWORD_KEY, pmcw.encode_utf8_base64(passwordComputed));
            });
    };
}
export default upgradeKeys;
