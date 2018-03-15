import { AxiosError } from 'axios';

let token: string;

export function getAuthToken(force?: boolean, silent: boolean = false): Promise<string> {
  console.log('Getting auth token', force);
  if (token && !force) {
    return Promise.resolve(token);
  }

  return new Promise((resolve) => {
    chrome.identity.getAuthToken({
      interactive: !silent
    }, (_token: string) => {
      // console.log('Token retrieved: ', _token.substr(0, 10) + '…');
      token = _token;
      resolve(token);
    });
  });
}

export async function withAuthToken<T>(callback: (token: string) => Promise<T>): Promise<T> {
  let numRetries = 0;
  while (true) {
    numRetries++;
    console.log('Getting token');
    const token = await getAuthToken(numRetries > 0);
    console.log('Got token', token);
    try {
      return await callback(token);
    } catch (e) {
      console.log('Error doing authed action', e);
      const axiosError = e as AxiosError;
      const responseData = axiosError.response && axiosError.response.data && axiosError.response.data.error;
      if (numRetries < 3 && responseData && responseData.code === 401 && responseData.message === 'Invalid Credentials') {
        console.log('Failed to authenticate retrying: ', e);
      } else {
        throw e;
      }
    }
  }
}